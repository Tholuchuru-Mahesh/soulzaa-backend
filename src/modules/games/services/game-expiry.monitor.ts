import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LockService } from 'src/infra/redis/lock.service';
import { GAME_MONITOR_INTERVAL_MS, GAME_MONITOR_LOCK_KEY } from '../constants/games.constants';
import { GamesService } from './games.service';

/**
 * Sweeps time-based game state on a short cadence, single-instance via a Redis
 * lock: unstarted lobbies past their TTL (EXPIRED), matchmaking ready-checks past
 * their deadline (dissolved), and stale queue entries. On shutdown it best-effort
 * drains live ready-checks so another instance can rematch.
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

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    try {
      await this.games.drainMatchmaking();
    } catch (err) {
      this.logger.warn(`Matchmaking drain failed: ${(err as Error).message}`);
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const release = await this.locks.acquire(GAME_MONITOR_LOCK_KEY, GAME_MONITOR_INTERVAL_MS);
      if (!release) return;
      try {
        const now = new Date();
        await this.games.sweepExpiredLobbies(now);
        await this.games.sweepExpiredReadyChecks(now);
        await this.games.sweepStaleQueueEntries(now);
      } finally {
        await release();
      }
    } catch (err) {
      this.logger.warn(`Game monitor sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
