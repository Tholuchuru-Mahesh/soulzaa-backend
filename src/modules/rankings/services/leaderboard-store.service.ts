import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS_CLIENT, type RedisClient } from 'src/infra/redis/redis.constants';
import { errorMessage } from '../constants/error-message.util';
import { buildLeaderboardKey, leaderboardTag } from '../constants/ranking-keys';

export interface RankedEntry {
  member: string;
  score: number;
}

export interface LeaderboardIncrement {
  key: string;
  member: string;
  delta: number;
  /** Refreshed on every write; omit for ladders that must not expire. */
  ttlSeconds?: number;
}

/**
 * Entries per ZADD in `replace()`'s rebuild. Two independent ceilings, both
 * of which this stays well under:
 *  - V8's per-call argument limit. `zadd(tmp, ...scoreMembers)` spreads the
 *    array as call arguments, and V8 throws `RangeError: Maximum call stack
 *    size exceeded` once that spread gets too large (measured on this
 *    machine: 124,185 arguments succeed, 124,186 throw). Each entry
 *    contributes 2 arguments (score, member), so a single unbatched ZADD
 *    caps out around 62,000 entries — a limit a global "top gifters" ladder
 *    blows past routinely.
 *  - Redis's single-threaded command loop. Even an argument list under the
 *    V8 ceiling would, issued as one giant ZADD, occupy Redis for the whole
 *    time it takes to apply hundreds of thousands of members — blocking
 *    every other client on that node for the duration. Small batches keep
 *    any one command cheap regardless of how large the ladder is.
 */
const REPLACE_BATCH_SIZE = 1000;

/**
 * Generic sorted-set leaderboard store. Knows nothing about video rooms,
 * gifts or any dimension — it moves scores in and out of ZSETs and derives
 * one ladder from others.
 *
 * Cluster safety: every multi-key command here (ZUNIONSTORE, RENAME) requires
 * its keys to share a slot. That is guaranteed by `buildLeaderboardKey`'s
 * `{scope|dimension}` hash tag plus the rule that a derive only ever unions
 * keys of the SAME scope+dimension across dateKeys, and a replace only ever
 * renames a `:tmp` suffix of the very key it targets.
 */
@Injectable()
export class LeaderboardStore {
  private readonly logger = new Logger(LeaderboardStore.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

  key(
    namespace: string,
    scope: string,
    dimension: string,
    period: string,
    dateKey: string,
  ): string {
    return buildLeaderboardKey({ namespace, scope, dimension, period, dateKey });
  }

  async increment(key: string, member: string, delta: number): Promise<number> {
    return Number(await this.redis.zincrby(key, delta, member));
  }

  /**
   * One pipeline for a whole fan-out. A single gift touches ~5 periods across
   * ~4 scopes for ~4 dimensions; issuing those as individual round trips would
   * put ~80 RTTs on the hot path of every gift sent on the platform.
   */
  async incrementMany(increments: LeaderboardIncrement[]): Promise<void> {
    if (increments.length === 0) return;
    const pipe = this.redis.pipeline();
    for (const { key, member, delta, ttlSeconds } of increments) {
      pipe.zincrby(key, delta, member);
      if (ttlSeconds !== undefined) pipe.expire(key, ttlSeconds);
    }
    await pipe.exec();
  }

  async range(key: string, start: number, stop: number): Promise<RankedEntry[]> {
    return this.decode(await this.redis.zrevrange(key, start, stop, 'WITHSCORES'));
  }

  top(key: string, limit: number): Promise<RankedEntry[]> {
    // ZREVRANGE treats a stop of -1 as "last element", so limit - 1 at
    // limit <= 0 would otherwise return the whole ladder instead of none.
    if (limit <= 0) return Promise.resolve([]);
    return this.range(key, 0, limit - 1);
  }

  private decode(flat: string[]): RankedEntry[] {
    const entries: RankedEntry[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      entries.push({ member: flat[i], score: Number(flat[i + 1]) });
    }
    return entries;
  }

  /** Scores for many members in one call — the projection primitive. */
  async scoreMany(key: string, members: string[]): Promise<(number | null)[]> {
    if (members.length === 0) return [];
    const raw = await this.redis.zmscore(key, ...members);
    return raw.map((s) => (s === null ? null : Number(s)));
  }

  async rank(key: string, member: string): Promise<number | null> {
    return this.redis.zrevrank(key, member);
  }

  async score(key: string, member: string): Promise<number | null> {
    const s = await this.redis.zscore(key, member);
    return s === null ? null : Number(s);
  }

  count(key: string): Promise<number> {
    return this.redis.zcard(key);
  }

  /**
   * Materialise `destKey` as the union of `sourceKeys` (a derived period built
   * from its hot constituents). With no sources the destination is deleted
   * rather than left holding a previous run's data — a quarter with no months
   * must read as empty, not as stale.
   */
  async derive(destKey: string, sourceKeys: string[], ttlSeconds: number): Promise<number> {
    if (sourceKeys.length === 0) {
      await this.redis.del(destKey);
      return 0;
    }
    const written = await this.redis.zunionstore(destKey, sourceKeys.length, ...sourceKeys);
    await this.redis.expire(destKey, ttlSeconds);
    return written;
  }

  /**
   * Atomically swap a ladder's contents — the recompute path's commit step.
   *
   * Built into `<key>:tmp` and RENAMEd rather than DEL-then-ZADD so readers
   * never observe a half-built or empty ladder. The `:tmp` suffix sits OUTSIDE
   * the `{...}` hash tag, so both keys hash to the same slot and RENAME is
   * legal on Cluster.
   */
  async replace(key: string, entries: RankedEntry[], ttlSeconds: number): Promise<void> {
    const tmp = `${key}:tmp`;
    if (entries.length === 0) {
      // Also clear a would-be tmp key: a prior replace() that crashed after
      // building tmp but before RENAME would otherwise leave it orphaned.
      await this.redis.del(key);
      await this.redis.del(tmp);
      return;
    }
    await this.redis.del(tmp);
    const pipe = this.redis.pipeline();
    for (let i = 0; i < entries.length; i += REPLACE_BATCH_SIZE) {
      const batch = entries.slice(i, i + REPLACE_BATCH_SIZE);
      const scoreMembers = batch.flatMap(({ score, member }) => [score, member]);
      pipe.zadd(tmp, ...scoreMembers);
    }
    await pipe.exec();
    await this.redis.rename(tmp, key);
    await this.redis.expire(key, ttlSeconds);
  }

  expire(key: string, ttlSeconds: number): Promise<number> {
    return this.redis.expire(key, ttlSeconds);
  }

  /**
   * Monotonic ladder version. Cached pages embed the value read at write time;
   * a page whose embed no longer matches is a miss. Invalidating every cached
   * page of a ladder is therefore one INCR, however many pages exist — the same
   * technique VideoRoomPermissionCache uses for room permissions.
   */
  async version(namespace: string, scope: string, dimension: string): Promise<number> {
    const raw = await this.redis.get(this.versionKey(namespace, scope, dimension));
    return raw === null ? 0 : Number(raw);
  }

  bumpVersion(namespace: string, scope: string, dimension: string): Promise<number> {
    return this.redis.incr(this.versionKey(namespace, scope, dimension));
  }

  /**
   * Bump many ladder versions in ONE pipeline. A single gift can touch up to
   * 4 scopes x 4 dimensions — issued as individual INCRs that is 16 round
   * trips reintroducing exactly the per-key cost `incrementMany` exists to
   * avoid. Mirrors `incrementMany`'s pipelining.
   */
  async bumpVersionMany(
    namespace: string,
    pairs: { scope: string; dimension: string }[],
  ): Promise<void> {
    if (pairs.length === 0) return;
    const pipe = this.redis.pipeline();
    for (const { scope, dimension } of pairs) {
      pipe.incr(this.versionKey(namespace, scope, dimension));
    }
    await pipe.exec();
  }

  private versionKey(namespace: string, scope: string, dimension: string): string {
    return `${namespace}:ver:${leaderboardTag(scope, dimension)}`;
  }

  /**
   * Claim a source event exactly once. `true` means "you own this event, apply
   * it"; `false` means it was already applied.
   *
   * FAILS OPEN. Any thrown error — Redis unreachable, a timeout, a malformed
   * reply, or anything else — is treated the same as "not seen before", so
   * the answer is `true` and a gift still moves the ladder. The asymmetry is
   * deliberate: an over-count is corrected by the next recompute, while a
   * write refused because the dedupe layer failed is lost until that same
   * recompute — and the user watching the ladder sees nothing happen in the
   * meantime.
   */
  async markSeen(
    namespace: string,
    source: string,
    naturalId: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const key = `${namespace}:seen:${source}:${naturalId}`;
    try {
      return (await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
    } catch (err) {
      this.logger.warn(`dedupe marker unavailable for ${key}: ${errorMessage(err)}`);
      return true;
    }
  }
}
