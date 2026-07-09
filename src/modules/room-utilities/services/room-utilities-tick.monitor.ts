import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { LockService } from 'src/infra/redis/lock.service';
import {
  COUNTDOWN_MONITOR_INTERVAL_MS,
  COUNTDOWN_MONITOR_LOCK_KEY,
} from '../constants/room-utilities.constants';
import { CountdownService } from './countdown.service';
import { PollService } from './poll.service';

/**
 * Drives time-based room utilities on a fixed tick: broadcasts countdown
 * progress + completes elapsed countdowns, and auto-ends polls past their
 * window. Guarded by a short Redis lock so exactly one instance runs per tick
 * across the fleet (mirrors AR-6's expiry monitors).
 */
@Injectable()
export class RoomUtilitiesTickMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoomUtilitiesTickMonitor.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly countdown: CountdownService,
    private readonly polls: PollService,
    private readonly locks: LockService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), COUNTDOWN_MONITOR_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const release = await this.locks.acquire(
        COUNTDOWN_MONITOR_LOCK_KEY,
        COUNTDOWN_MONITOR_INTERVAL_MS,
      );
      if (!release) return;
      try {
        const now = new Date();
        await this.countdown.tickAndComplete(now);
        await this.polls.endExpired(now);
      } finally {
        await release();
      }
    } catch (err) {
      this.logger.warn(`Room-utilities tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
