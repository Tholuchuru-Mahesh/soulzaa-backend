import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LockService } from 'src/infra/redis/lock.service';
import { GAME_MONITOR_INTERVAL_MS, GAME_MONITOR_LOCK_KEY } from '../constants/games.constants';
import { GamesService } from './games.service';

/**
 * Sweeps unstarted lobbies past their TTL and closes them (EXPIRED). A short
 * distributed lock ensures only one instance sweeps per tick.
 */
@Injectable()
export class GameExpiryMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GameExpiryMonitor.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly games: GamesService,
    private readonly locks: LockService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), GAME_MONITOR_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const release = await this.locks.acquire(GAME_MONITOR_LOCK_KEY, GAME_MONITOR_INTERVAL_MS);
      if (!release) return;
      try {
        await this.games.sweepExpiredLobbies(new Date());
      } finally {
        await release();
      }
    } catch (err) {
      this.logger.warn(`Game expiry sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
