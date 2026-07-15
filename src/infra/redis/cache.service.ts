import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT, RedisClient } from './redis.constants';

/** A leaderboard row: member and its score, highest first. */
export interface RankedEntry {
  member: string;
  score: number;
}

/**
 * Higher-level Redis data helpers built on the shared connection:
 *  - JSON caching (cache-aside)
 *  - session storage (TTL-scoped blobs)
 *  - counters with expiry (gift combos, rate windows)
 *  - sorted-set leaderboards (rankings)
 *
 * Every method touches a single key, so all of it is Redis Cluster-safe.
 * `del()` fans out one command per key rather than issuing a cross-slot
 * multi-key DEL.
 */
@Injectable()
export class CacheService {
  private static readonly SESSION_PREFIX = 'session:';

  constructor(@Inject(REDIS_CLIENT) private readonly client: RedisClient) {}

  // ---- Caching (JSON, cache-aside) ----

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const payload = JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client.set(key, payload, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, payload);
    }
  }

  /** Return the cached value or compute, cache (with TTL) and return it. */
  async getOrSet<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const fresh = await factory();
    await this.set(key, fresh, ttlSeconds);
    return fresh;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  /** Set/refresh a key's TTL (seconds). Used for rolling leaderboard retention. */
  async expire(key: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds > 0) await this.client.expire(key, ttlSeconds);
  }

  /** Cluster-safe delete: one command per key (keys may live on different slots). */
  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const removed = await Promise.all(keys.map((key) => this.client.del(key)));
    return removed.reduce((total, n) => total + n, 0);
  }

  // ---- Session storage ----

  async setSession<T>(sessionId: string, data: T, ttlSeconds: number): Promise<void> {
    await this.set(CacheService.SESSION_PREFIX + sessionId, data, ttlSeconds);
  }

  async getSession<T>(sessionId: string): Promise<T | null> {
    return this.get<T>(CacheService.SESSION_PREFIX + sessionId);
  }

  /** Slide the session TTL forward (call on each authenticated request). */
  async touchSession(sessionId: string, ttlSeconds: number): Promise<void> {
    await this.client.expire(CacheService.SESSION_PREFIX + sessionId, ttlSeconds);
  }

  async destroySession(sessionId: string): Promise<void> {
    await this.del(CacheService.SESSION_PREFIX + sessionId);
  }

  // ---- Counters (gift combos, rate windows) ----

  /**
   * Atomically increment a counter and (re)set its TTL on first write. Used for
   * gift combos: the key lives only for the combo window, so a lapse resets it.
   */
  async increment(key: string, opts: { by?: number; ttlSeconds?: number } = {}): Promise<number> {
    const { by = 1, ttlSeconds } = opts;
    const value = await this.client.incrby(key, by);
    if (ttlSeconds && ttlSeconds > 0 && value === by) {
      await this.client.expire(key, ttlSeconds);
    }
    return value;
  }

  // ---- Leaderboards (rankings, sorted sets) ----

  /** Set an absolute score (e.g. total coins) for a member. */
  async setScore(key: string, member: string, score: number): Promise<void> {
    await this.client.zadd(key, score, member);
  }

  /** Add to a member's score and return the new total (e.g. gifts received). */
  async addScore(key: string, member: string, delta: number): Promise<number> {
    const value = await this.client.zincrby(key, delta, member);
    return Number(value);
  }

  /** Top N members, highest score first. */
  async top(key: string, count: number): Promise<RankedEntry[]> {
    const flat = await this.client.zrevrange(key, 0, count - 1, 'WITHSCORES');
    const entries: RankedEntry[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      entries.push({ member: flat[i], score: Number(flat[i + 1]) });
    }
    return entries;
  }

  /** Zero-based rank of a member (0 = top), or null if absent. */
  async rank(key: string, member: string): Promise<number | null> {
    const r = await this.client.zrevrank(key, member);
    return r === null ? null : r;
  }

  async score(key: string, member: string): Promise<number | null> {
    const s = await this.client.zscore(key, member);
    return s === null ? null : Number(s);
  }

  // ---- Sorted-set primitives (matchmaking queue + ready-check index) ----
  // Single-key, so Cluster-safe. Callers serialize multi-step reads/writes with
  // LockService where ordering matters (e.g. read-lowest-then-remove).

  /** Number of members in a sorted set (0 if absent). */
  async sortedCount(key: string): Promise<number> {
    return this.client.zcard(key);
  }

  /** Ascending rank of a member (0 = lowest score), or null if absent. */
  async sortedRank(key: string, member: string): Promise<number | null> {
    const r = await this.client.zrank(key, member);
    return r === null ? null : r;
  }

  /** The `count` lowest-scored members with their scores, ascending. */
  async sortedLowest(key: string, count: number): Promise<RankedEntry[]> {
    if (count <= 0) return [];
    const flat = await this.client.zrange(key, 0, count - 1, 'WITHSCORES');
    const entries: RankedEntry[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      entries.push({ member: flat[i], score: Number(flat[i + 1]) });
    }
    return entries;
  }

  /** Remove members from a sorted set; returns how many were removed. */
  async sortedRemove(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return this.client.zrem(key, ...members);
  }

  /** Members with score in [min, max], ascending (used by the expiry sweep). */
  async sortedRangeByScore(key: string, min: number, max: number): Promise<string[]> {
    return this.client.zrangebyscore(key, min, max);
  }

  /** Drop members with score in [min, max] (stale-entry prune); returns count removed. */
  async sortedRemoveByScore(key: string, min: number, max: number): Promise<number> {
    return this.client.zremrangebyscore(key, min, max);
  }

  // ---- Set primitives (matchmaking bucket index — enumerate active buckets) ----

  async setAdd(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return this.client.sadd(key, ...members);
  }

  async setMembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  async setRemove(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return this.client.srem(key, ...members);
  }
}
