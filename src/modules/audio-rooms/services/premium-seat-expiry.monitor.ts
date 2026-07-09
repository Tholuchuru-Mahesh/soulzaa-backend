import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { LockService } from 'src/infra/redis/lock.service';
import {
  PREMIUM_SEAT_MONITOR_INTERVAL_MS,
  PREMIUM_SEAT_MONITOR_LOCK_KEY,
} from '../constants/premium.constants';
import { PremiumSeatRepository } from '../repositories/premium-seat.repository';
import { PremiumSeatService } from './premium-seat.service';

/**
 * Auto-revokes lapsed premium admin seats: finds ACTIVE seats past `expiresAt`,
 * strips the PREMIUM_ADMIN role, and flips them to EXPIRED. Guarded by a short
 * Redis lock so exactly one instance runs per tick (mirrors the other monitors).
 */
@Injectable()
export class PremiumSeatExpiryMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PremiumSeatExpiryMonitor.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly repo: PremiumSeatRepository,
    private readonly premium: PremiumSeatService,
    private readonly locks: LockService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), PREMIUM_SEAT_MONITOR_INTERVAL_MS);
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
        PREMIUM_SEAT_MONITOR_LOCK_KEY,
        PREMIUM_SEAT_MONITOR_INTERVAL_MS,
      );
      if (!release) return;
      try {
        const expired = await this.repo.findExpired(new Date());
        for (const seat of expired) {
          try {
            await this.premium.expire(seat);
          } catch (err) {
            this.logger.warn(`Failed to expire premium seat ${seat.id}: ${(err as Error).message}`);
          }
        }
      } finally {
        await release();
      }
    } catch (err) {
      this.logger.warn(`Premium seat sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
