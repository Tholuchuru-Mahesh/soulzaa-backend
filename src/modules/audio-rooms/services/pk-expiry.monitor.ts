import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { LockService } from 'src/infra/redis/lock.service';
import { PK_MONITOR_INTERVAL_MS, PK_MONITOR_LOCK_KEY } from '../constants/pk.constants';
import { PkBattleService } from './pk-battle.service';

/**
 * Completes PK battles whose timer has elapsed: finds ACTIVE battles past
 * `endsAt`, computes the winner, distributes badges + ranking, and broadcasts
 * the result. Guarded by a short Redis lock so exactly one instance runs per
 * tick (mirrors the other expiry monitors). Runs on a tight interval so results
 * land promptly at the timer's end.
 */
@Injectable()
export class PkExpiryMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PkExpiryMonitor.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly pk: PkBattleService,
    private readonly locks: LockService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), PK_MONITOR_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const release = await this.locks.acquire(PK_MONITOR_LOCK_KEY, PK_MONITOR_INTERVAL_MS);
      if (!release) return;
      try {
        await this.pk.completeExpired(new Date());
      } finally {
        await release();
      }
    } catch (err) {
      this.logger.warn(`PK expiry sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
