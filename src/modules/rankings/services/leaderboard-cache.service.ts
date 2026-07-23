import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from 'src/infra/redis/cache.service';
import { errorMessage } from '../constants/error-message.util';
import { leaderboardTag } from '../constants/ranking-keys';
import { LeaderboardStore } from './leaderboard-store.service';

/** A cached page carries the stamps that decide whether it is still valid. */
export interface CachedPage<T> {
  version: number;
  dateKey: string;
  payload: T;
}

/**
 * Read-through cache for HYDRATED leaderboard pages — the expensive artefact is
 * not the ZSET read but the user/room hydration that follows it (usernames,
 * avatars, levels, VIP tiers), which is what this stores.
 *
 * Validity is decided by a version stamp rather than a TTL alone, so a
 * recomputed ladder invalidates every one of its cached pages with a single
 * INCR instead of a key scan.
 *
 * Every failure path degrades to "miss". A cache exists to make the hot path
 * faster; it must never be the reason a request fails.
 */
@Injectable()
export class LeaderboardCache {
  private readonly logger = new Logger(LeaderboardCache.name);
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly cache: CacheService,
    private readonly store: LeaderboardStore,
  ) {}

  private cacheKey(
    namespace: string,
    scope: string,
    dimension: string,
    period: string,
    dateKey: string,
    page: number,
  ): string {
    return `${namespace}:cache:${leaderboardTag(scope, dimension)}:${period}:${dateKey}:${page}`;
  }

  async read<T>(
    namespace: string,
    scope: string,
    dimension: string,
    period: string,
    dateKey: string,
    page: number,
  ): Promise<T | null> {
    try {
      const [entry, version] = await Promise.all([
        this.cache.get<CachedPage<T>>(
          this.cacheKey(namespace, scope, dimension, period, dateKey, page),
        ),
        this.store.version(namespace, scope, dimension),
      ]);

      if (entry && entry.version === version && entry.dateKey === dateKey) {
        this.hits += 1;
        return entry.payload;
      }
    } catch (err) {
      this.logger.warn(`leaderboard cache read failed: ${errorMessage(err)}`);
    }
    this.misses += 1;
    return null;
  }

  async write<T>(
    namespace: string,
    scope: string,
    dimension: string,
    period: string,
    dateKey: string,
    page: number,
    payload: T,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      const version = await this.store.version(namespace, scope, dimension);
      await this.cache.set<CachedPage<T>>(
        this.cacheKey(namespace, scope, dimension, period, dateKey, page),
        { version, dateKey, payload },
        ttlSeconds,
      );
    } catch (err) {
      this.logger.warn(`leaderboard cache write failed: ${errorMessage(err)}`);
    }
  }

  /** Read and reset the hit/miss counters — drained by the metrics listener. */
  snapshotCounters(): { hits: number; misses: number } {
    const snapshot = { hits: this.hits, misses: this.misses };
    this.hits = 0;
    this.misses = 0;
    return snapshot;
  }
}
