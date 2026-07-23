import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from 'src/infra/redis/cache.service';
import {
  errorMessage,
  scopeCity,
  scopeCountry,
  scopeGlobal,
  scopeRoom,
} from '../constants/video-room-ranking.constants';
import { VideoRoomRankingRepository } from '../repositories/video-room-ranking.repository';

export interface UserGeo {
  country: string | null;
  city: string | null;
}

const EMPTY_GEO: UserGeo = { country: null, city: null };

/**
 * A user's country/city rarely changes, and a gift storm can ask for the same
 * one thousands of times a second. 24h is long enough that the database is
 * effectively out of the hot path, and short enough that a user who relocates
 * is ranked correctly by the next day — with `invalidate` available for the
 * profile-update path to make it immediate.
 */
const GEO_TTL_SECONDS = 86_400;

/**
 * Resolves the scopes a ranking write fans out to.
 *
 * Every write already costs ~5 ZINCRBYs per dimension; if it also cost a
 * Postgres round trip to learn the sender's country, the ranking engine would
 * become the slowest part of sending a gift. So geography is cached
 * aggressively and every failure path degrades to "no geography" — the global
 * and room ladders still move, and the recompute pass restores the country and
 * city ladders from source rows regardless of what was cached at write time.
 */
@Injectable()
export class VideoRoomRankingScopeResolver {
  private readonly logger = new Logger(VideoRoomRankingScopeResolver.name);

  constructor(
    private readonly cache: CacheService,
    private readonly repo: VideoRoomRankingRepository,
  ) {}

  private cacheKey(userId: string): string {
    return `vrank:geo:${userId}`;
  }

  async geoFor(userId: string): Promise<UserGeo> {
    const map = await this.geoForMany([userId]);
    return map.get(userId) ?? EMPTY_GEO;
  }

  /**
   * Batch resolve. Cached users are served from Redis; the remainder go to the
   * database in ONE query rather than one per user — the difference between a
   * constant and a linear cost when the recompute pass hydrates a whole ladder.
   */
  async geoForMany(userIds: string[]): Promise<Map<string, UserGeo>> {
    const resolved = new Map<string, UserGeo>();
    if (userIds.length === 0) return resolved;

    const unique = [...new Set(userIds)];
    const misses: string[] = [];

    // Reads are independent per id — a Redis Cluster round trip each — so they
    // are fanned out with Promise.all rather than awaited one at a time. The
    // try/catch stays INSIDE each mapped callback so one id's rejection only
    // degrades that id, not the whole batch.
    const reads = await Promise.all(
      unique.map(async (userId) => {
        try {
          return { userId, cached: await this.cache.get<UserGeo>(this.cacheKey(userId)) };
        } catch (err) {
          this.logger.warn(`geo cache read failed for ${userId}: ${errorMessage(err)}`);
          return { userId, cached: null as UserGeo | null };
        }
      }),
    );

    for (const { userId, cached } of reads) {
      if (cached) resolved.set(userId, cached);
      else misses.push(userId);
    }

    if (misses.length === 0) return resolved;

    let rows: { userId: string; country: string | null; city: string | null }[] = [];
    try {
      rows = await this.repo.findUserGeo(misses);
    } catch (err) {
      // Degrade, do not throw: a gift must still move the global ladder.
      this.logger.warn(`geo lookup failed: ${errorMessage(err)}`);
      for (const userId of misses) resolved.set(userId, EMPTY_GEO);
      return resolved;
    }

    const byId = new Map(rows.map((r) => [r.userId, { country: r.country, city: r.city }]));

    // A user with no row still gets an entry — and gets it CACHED. Without
    // this, every gift from a user with no profile row would re-query.
    for (const userId of misses) {
      resolved.set(userId, byId.get(userId) ?? EMPTY_GEO);
    }

    await Promise.all(
      misses.map(async (userId) => {
        try {
          await this.cache.set<UserGeo>(
            this.cacheKey(userId),
            resolved.get(userId) as UserGeo,
            GEO_TTL_SECONDS,
          );
        } catch (err) {
          this.logger.warn(`geo cache write failed for ${userId}: ${errorMessage(err)}`);
        }
      }),
    );

    return resolved;
  }

  /**
   * The ordered scope list a write fans out to: always global, then whichever
   * of country/city the user has set, then the room when the event happened in
   * one. Order is stable so tests and logs read consistently.
   */
  async scopesFor(userId: string, roomId?: string): Promise<string[]> {
    const geo = await this.geoFor(userId);
    const scopes = [scopeGlobal()];
    if (geo.country) scopes.push(scopeCountry(geo.country));
    if (geo.city) scopes.push(scopeCity(geo.city));
    if (roomId) scopes.push(scopeRoom(roomId));
    return scopes;
  }

  /** Called when a user's profile geography changes, so the next write is correct. */
  async invalidate(userId: string): Promise<void> {
    try {
      await this.cache.del(this.cacheKey(userId));
    } catch (err) {
      // Degrade, do not throw: a profile-geo update must not fail on a Redis hiccup.
      this.logger.warn(`geo cache invalidate failed for ${userId}: ${errorMessage(err)}`);
    }
  }
}
