import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LockService } from 'src/infra/redis/lock.service';
import {
  CASINO_WINDOW_SWEEP_INTERVAL_MS,
  CASINO_WINDOW_SWEEP_LOCK_KEY,
} from '../constants/casino.constants';
import { RoomCasinoWindowService } from './room-casino-window.service';

/**
 * Orphan-window safety net for audio-room casino windows: periodically closes
 * every ACTIVE casino-window `GameSession` whose audio room is no longer live
 * (room ended/deleted without the ENDED/DELETED event reaching us, or a crash
 * between window-create and room-end). Single-instance across replicas via the
 * Redis `CASINO_WINDOW_SWEEP_LOCK_KEY`, mirroring `GameExpiryMonitor`'s
 * acquire/release pattern. Also runs one sweep on bootstrap to clear anything
 * left over from previous downtime.
 *
 * The event-driven paths (ENDED / DELETED / OWNERSHIP_TRANSFERRED) are primary;
 * this monitor is only the backstop.
 */
@Injectable()
export class RoomCasinoWindowMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoomCasinoWindowMonitor.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly windows: RoomCasinoWindowService,
    private readonly locks: LockService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), CASINO_WINDOW_SWEEP_INTERVAL_MS);
    this.timer.unref();
    // Bootstrap sweep clears orphaned windows left over from previous downtime.
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const release = await this.locks.acquire(
        CASINO_WINDOW_SWEEP_LOCK_KEY,
        CASINO_WINDOW_SWEEP_INTERVAL_MS,
      );
      if (!release) return;
      try {
        const closed = await this.windows.sweepOrphanWindows();
        if (closed > 0) this.logger.log(`Closed ${closed} orphaned casino window(s)`);
      } finally {
        await release();
      }
    } catch (err) {
      this.logger.warn(`Casino window sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
