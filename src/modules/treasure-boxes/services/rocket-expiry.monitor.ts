import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { LockService } from 'src/infra/redis/lock.service';
import {
  ROCKET_MONITOR_INTERVAL_MS,
  ROCKET_MONITOR_LOCK_KEY,
} from '../constants/treasure.constants';
import { RocketService } from './rocket.service';

/**
 * Completes rocket events whose timer has elapsed: finds ACTIVE rockets past
 * `endsAt`, distributes their reward pool, and broadcasts completion. Guarded by
 * a short Redis lock so exactly one instance runs per tick across the fleet
 * (mirrors AR-3's ModerationExpiryMonitor).
 */
@Injectable()
export class RocketExpiryMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RocketExpiryMonitor.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly rocket: RocketService,
    private readonly locks: LockService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), ROCKET_MONITOR_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const release = await this.locks.acquire(ROCKET_MONITOR_LOCK_KEY, ROCKET_MONITOR_INTERVAL_MS);
      if (!release) return;
      try {
        await this.rocket.completeExpired(new Date());
      } finally {
        await release();
      }
    } catch (err) {
      this.logger.warn(`Rocket expiry sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
