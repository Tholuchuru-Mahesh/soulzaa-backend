import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { LockService } from 'src/infra/redis/lock.service';
import {
  MODERATION_MONITOR_INTERVAL_MS,
  MODERATION_MONITOR_LOCK_KEY,
} from '../constants/moderation.constants';
import { ModerationRepository } from '../repositories/moderation.repository';
import { ModerationService } from './moderation.service';

/**
 * Reconciles expired temporary bans/mutes: the per-user Redis TTL key auto-lifts
 * the hot enforcement path, but the DB row stays ACTIVE and the SET membership
 * lingers until this sweep flips them to EXPIRED, clears Redis, and emits
 * unban/unmute events. Guarded by a short Redis lock so exactly one instance
 * runs per tick across the fleet (mirrors AR-2's VoiceHeartbeatMonitor).
 */
@Injectable()
export class ModerationExpiryMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ModerationExpiryMonitor.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly repo: ModerationRepository,
    private readonly moderation: ModerationService,
    private readonly locks: LockService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), MODERATION_MONITOR_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const release = await this.locks.acquire(
        MODERATION_MONITOR_LOCK_KEY,
        MODERATION_MONITOR_INTERVAL_MS,
      );
      if (!release) return;
      try {
        const now = new Date();
        const [bans, mutes] = await Promise.all([
          this.repo.findExpiredBans(now),
          this.repo.findExpiredMutes(now),
        ]);
        for (const ban of bans) {
          try {
            await this.moderation.expireBan(ban);
          } catch (err) {
            this.logger.warn(`Failed to expire ban ${ban.id}: ${(err as Error).message}`);
          }
        }
        for (const mute of mutes) {
          try {
            await this.moderation.expireMute(mute);
          } catch (err) {
            this.logger.warn(`Failed to expire mute ${mute.id}: ${(err as Error).message}`);
          }
        }
        if (bans.length || mutes.length) {
          this.logger.debug(`Expired ${bans.length} ban(s), ${mutes.length} mute(s)`);
        }
      } finally {
        await release();
      }
    } catch (err) {
      this.logger.warn(`Moderation expiry sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
