import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { REDIS_CLIENT, RedisClient } from './redis.constants';

/**
 * Single-instance distributed lock (SET NX PX + safe Lua release).
 * Good enough for serialising wallet debits, seat claims, game rounds, etc.
 * across horizontally-scaled API instances sharing one Redis.
 *
 * Cluster-safe: acquire/release each touch a single key, and the Lua release
 * script references exactly one KEY, so it runs on that key's slot. If we later
 * need stronger multi-node guarantees, this class is the seam to swap for full
 * Redlock without touching callers.
 */
@Injectable()
export class LockService {
  private readonly logger = new Logger(LockService.name);

  // Atomic compare-and-delete so we only release a lock we still own.
  private static readonly RELEASE_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end`;

  constructor(@Inject(REDIS_CLIENT) private readonly client: RedisClient) {}

  /** Try to acquire once. Returns a release fn, or null if not acquired. */
  async acquire(key: string, ttlMs = 10_000): Promise<(() => Promise<void>) | null> {
    const token = randomUUID();
    const ok = await this.client.set(key, token, 'PX', ttlMs, 'NX');
    if (ok !== 'OK') return null;
    return async () => {
      await this.client.eval(LockService.RELEASE_SCRIPT, 1, key, token);
    };
  }

  /**
   * Acquire with bounded retries, then run `fn` under the lock and always
   * release. Throws if the lock cannot be acquired within the retry budget.
   */
  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    opts: { ttlMs?: number; retries?: number; retryDelayMs?: number } = {},
  ): Promise<T> {
    const { ttlMs = 10_000, retries = 20, retryDelayMs = 100 } = opts;
    let release: (() => Promise<void>) | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      release = await this.acquire(key, ttlMs);
      if (release) break;
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
    if (!release) {
      throw new Error(`Could not acquire lock "${key}" after ${retries} retries`);
    }

    try {
      return await fn();
    } finally {
      try {
        await release();
      } catch (err) {
        this.logger.warn(`Failed to release lock "${key}": ${(err as Error).message}`);
      }
    }
  }
}
