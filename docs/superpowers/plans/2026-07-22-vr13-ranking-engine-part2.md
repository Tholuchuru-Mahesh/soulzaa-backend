# VR-13 Ranking Engine — Implementation Plan, Part 2 (Tasks 8–13)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **Read Part 1 first:** `docs/superpowers/plans/2026-07-22-vr13-ranking-engine.md`. Its **Global Constraints** apply to every task here — in particular: **never run `git commit` or `git push`**, never write `rankings:*` keys, and never put Prisma inside a service.

**Covers:** the scope resolver, the repository (plus two additive indexes on existing tables), the domain events, the write path, the activity listener, and the recompute engine.

---

## Task 8: VideoRoomRankingScopeResolver

Resolves the geography scopes a write fans out to. Cached hard, because it sits on the hot path of every gift on the platform.

**Files:**
- Create: `src/modules/video-rooms/services/video-room-ranking-scope.resolver.ts`
- Test: `src/modules/video-rooms/services/video-room-ranking-scope.resolver.spec.ts`

**Interfaces:**
- Consumes: `scopeCountry`, `scopeCity`, `scopeGlobal`, `scopeRoom` (Task 6); `CacheService`; `VideoRoomRankingRepository.findUserGeo` (Task 9 — **write the resolver against this signature now; Task 9 implements it**): `findUserGeo(userIds: string[]): Promise<{ userId: string; country: string | null; city: string | null }[]>`.
- Produces:
  - `interface UserGeo { country: string | null; city: string | null }`
  - `class VideoRoomRankingScopeResolver` with:
    - `geoFor(userId: string): Promise<UserGeo>`
    - `geoForMany(userIds: string[]): Promise<Map<string, UserGeo>>`
    - `scopesFor(userId: string, roomId?: string): Promise<string[]>`
    - `invalidate(userId: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/services/video-room-ranking-scope.resolver.spec.ts`:

```ts
import { VideoRoomRankingScopeResolver } from './video-room-ranking-scope.resolver';

describe('VideoRoomRankingScopeResolver', () => {
  let cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let repo: { findUserGeo: jest.Mock };
  let resolver: VideoRoomRankingScopeResolver;

  beforeEach(() => {
    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(1),
    };
    repo = {
      findUserGeo: jest
        .fn()
        .mockResolvedValue([{ userId: 'u1', country: 'IN', city: 'city-9' }]),
    };
    resolver = new VideoRoomRankingScopeResolver(cache as never, repo as never);
  });

  describe('geoFor', () => {
    it('reads through to the repository on a cache miss and caches the result', async () => {
      await expect(resolver.geoFor('u1')).resolves.toEqual({ country: 'IN', city: 'city-9' });
      expect(repo.findUserGeo).toHaveBeenCalledWith(['u1']);
      expect(cache.set).toHaveBeenCalledWith(
        'vrank:geo:u1',
        { country: 'IN', city: 'city-9' },
        expect.any(Number),
      );
    });

    it('serves a cached value without touching the database', async () => {
      cache.get.mockResolvedValue({ country: 'US', city: null });
      await expect(resolver.geoFor('u1')).resolves.toEqual({ country: 'US', city: null });
      expect(repo.findUserGeo).not.toHaveBeenCalled();
    });

    it('caches a null geo so an unknown user is not looked up on every gift', async () => {
      repo.findUserGeo.mockResolvedValue([]);
      await expect(resolver.geoFor('ghost')).resolves.toEqual({ country: null, city: null });
      expect(cache.set).toHaveBeenCalledWith(
        'vrank:geo:ghost',
        { country: null, city: null },
        expect.any(Number),
      );
    });

    it('degrades to an empty geo when the lookup throws, rather than failing the write', async () => {
      repo.findUserGeo.mockRejectedValue(new Error('db down'));
      await expect(resolver.geoFor('u1')).resolves.toEqual({ country: null, city: null });
    });
  });

  describe('geoForMany', () => {
    it('issues one query for every uncached user', async () => {
      repo.findUserGeo.mockResolvedValue([
        { userId: 'u1', country: 'IN', city: 'c1' },
        { userId: 'u2', country: 'US', city: null },
      ]);
      const map = await resolver.geoForMany(['u1', 'u2']);
      expect(repo.findUserGeo).toHaveBeenCalledTimes(1);
      expect(repo.findUserGeo).toHaveBeenCalledWith(['u1', 'u2']);
      expect(map.get('u1')).toEqual({ country: 'IN', city: 'c1' });
      expect(map.get('u2')).toEqual({ country: 'US', city: null });
    });

    it('queries only the users the cache missed', async () => {
      cache.get.mockImplementation((k: string) =>
        Promise.resolve(k === 'vrank:geo:u1' ? { country: 'IN', city: 'c1' } : null),
      );
      repo.findUserGeo.mockResolvedValue([{ userId: 'u2', country: 'US', city: null }]);
      await resolver.geoForMany(['u1', 'u2']);
      expect(repo.findUserGeo).toHaveBeenCalledWith(['u2']);
    });

    it('does not query at all for an empty list', async () => {
      await expect(resolver.geoForMany([])).resolves.toEqual(new Map());
      expect(repo.findUserGeo).not.toHaveBeenCalled();
    });
  });

  describe('scopesFor', () => {
    it('always includes global, and adds country/city/room when known', async () => {
      await expect(resolver.scopesFor('u1', 'room-1')).resolves.toEqual([
        'g',
        'c:IN',
        'y:city-9',
        'r:room-1',
      ]);
    });

    it('omits geography scopes the user has not set', async () => {
      repo.findUserGeo.mockResolvedValue([{ userId: 'u1', country: null, city: null }]);
      await expect(resolver.scopesFor('u1')).resolves.toEqual(['g']);
    });

    it('omits the room scope when no room is supplied', async () => {
      await expect(resolver.scopesFor('u1')).resolves.toEqual(['g', 'c:IN', 'y:city-9']);
    });
  });

  it('drops the cached entry on invalidate', async () => {
    await resolver.invalidate('u1');
    expect(cache.del).toHaveBeenCalledWith('vrank:geo:u1');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm test -- src/modules/video-rooms/services/video-room-ranking-scope.resolver.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

Create `src/modules/video-rooms/services/video-room-ranking-scope.resolver.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from 'src/infra/redis/cache.service';
import {
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

    for (const userId of unique) {
      let cached: UserGeo | null = null;
      try {
        cached = await this.cache.get<UserGeo>(this.cacheKey(userId));
      } catch (err) {
        this.logger.warn(`geo cache read failed for ${userId}: ${(err as Error).message}`);
      }
      if (cached) resolved.set(userId, cached);
      else misses.push(userId);
    }

    if (misses.length === 0) return resolved;

    let rows: { userId: string; country: string | null; city: string | null }[] = [];
    try {
      rows = await this.repo.findUserGeo(misses);
    } catch (err) {
      // Degrade, do not throw: a gift must still move the global ladder.
      this.logger.warn(`geo lookup failed: ${(err as Error).message}`);
      for (const userId of misses) resolved.set(userId, EMPTY_GEO);
      return resolved;
    }

    const byId = new Map(rows.map((r) => [r.userId, { country: r.country, city: r.city }]));

    for (const userId of misses) {
      // A user with no row still gets an entry — and gets it CACHED. Without
      // this, every gift from a user with no profile row would re-query.
      const geo = byId.get(userId) ?? EMPTY_GEO;
      resolved.set(userId, geo);
      try {
        await this.cache.set<UserGeo>(this.cacheKey(userId), geo, GEO_TTL_SECONDS);
      } catch (err) {
        this.logger.warn(`geo cache write failed for ${userId}: ${(err as Error).message}`);
      }
    }

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
    await this.cache.del(this.cacheKey(userId));
  }
}
```

- [ ] **Step 4: Run the test**

```bash
pnpm test -- src/modules/video-rooms/services/video-room-ranking-scope.resolver.spec.ts
```

Expected: PASS. TypeScript will not compile until Task 9 creates the repository — if `tsc` complains about the missing import, proceed to Task 9 and re-run then. The Jest test itself passes with the mocked repository.

- [ ] **Step 5: Report and stop.** **Do not commit.**

---

## Task 9: VideoRoomRankingRepository (+ two additive indexes)

The only place VR-13 touches Prisma. Also adds two indexes to existing tables — **additive only** (no columns, no data, no constraint changes), because the recompute path would otherwise table-scan.

**Files:**
- Create: `src/modules/video-rooms/repositories/video-room-ranking.repository.ts`
- Test: `src/modules/video-rooms/repositories/video-room-ranking.repository.spec.ts`
- Modify: `prisma/schema/gifts.prisma` (one `@@index` line)
- Modify: `prisma/schema/video_rooms_treasure.prisma` (one `@@index` line)
- Create: `prisma/schema/migrations/20260722200100_video_rooms_phase13_ranking_indexes/migration.sql`

**Interfaces:**
- Consumes: `PrismaService`; Prisma models from Task 5.
- Produces `class VideoRoomRankingRepository` with:
  - `findUserGeo(userIds: string[]): Promise<{ userId: string; country: string | null; city: string | null }[]>`
  - `saveRankingSnapshots(rows: Prisma.VideoRoomRankingSnapshotCreateManyInput[]): Promise<number>`
  - `findRankingSnapshots(scope, dimension, period, dateKey, skip, take): Promise<[VideoRoomRankingSnapshot[], number]>`
  - `findTargetHistory(targetId, dimension, period, take): Promise<VideoRoomRankingSnapshot[]>`
  - `upsertLeaderboardSnapshot(input): Promise<void>`
  - `findLeaderboardSnapshot(scope, dimension, period, dateKey): Promise<VideoRoomLeaderboardSnapshot | null>`
  - `beginAggregation(key, windowStart, windowEnd): Promise<'CLAIMED' | 'ALREADY_SUCCEEDED'>`
  - `completeAggregation(key, stats): Promise<void>`
  - `failAggregation(key, error): Promise<void>`
  - `aggregateGiftCoinsBySender(window, roomId?): Promise<{ userId: string; coins: bigint; gifts: number }[]>`
  - `aggregateGiftCoinsByReceiver(window, roomId?): Promise<{ userId: string; coins: bigint; gifts: number }[]>`
  - `aggregateGiftCoinsByRoom(window): Promise<{ roomId: string; coins: bigint; gifts: number }[]>`
  - `aggregatePkOutcomes(window): Promise<{ userId: string; wins: number; losses: number; score: bigint; giftCoins: bigint }[]>`
  - `aggregateTreasureWinnings(window): Promise<{ userId: string; coins: bigint; events: number }[]>`
  - `findRoomStatistics(roomIds: string[]): Promise<{ roomId: string; peakViewers: number; avgWatchTimeSeconds: number; totalPkCount: number }[]>`
  - `pruneSnapshots(period: string, olderThan: Date): Promise<number>`

  Where `window` is `{ start: Date; end: Date }` and `key` is `{ scope: string; dimension: string; period: string; dateKey: string }`.

- [ ] **Step 1: Add the two indexes to the shared schemas**

In `prisma/schema/gifts.prisma`, inside `model GiftTransaction`, add one line to the existing index block:

```prisma
  @@index([contextType, contextId, createdAt])
  /// VR-13: the global video-room recompute filters on contextType + a time
  /// window with no contextId. The composite index above cannot serve that —
  /// contextId is the second column — so an hourly global aggregation would
  /// sequential-scan gift_transactions. Additive: no column or constraint change.
  @@index([contextType, createdAt])
  @@index([senderId, createdAt])
```

In `prisma/schema/video_rooms_treasure.prisma`, inside `model TreasureWinner`:

```prisma
  @@index([roomId])
  @@index([userId])
  /// VR-13: treasure-dimension recompute selects winners by selectedAt window.
  @@index([selectedAt])
```

- [ ] **Step 2: Write the index migration**

Create `prisma/schema/migrations/20260722200100_video_rooms_phase13_ranking_indexes/migration.sql`:

```sql
-- VR-13: indexes the ranking recompute path needs. Additive only — no columns,
-- no constraints, no data change. Safe to apply to a live database.

-- Global (non-room-scoped) video-room recompute: WHERE contextType = 'VIDEO_ROOM'
-- AND createdAt >= $1 AND createdAt < $2. The existing
-- (contextType, contextId, createdAt) index cannot serve this, because
-- contextId is unbound.
CREATE INDEX "gift_transactions_contextType_createdAt_idx"
    ON "gift_transactions" ("contextType", "createdAt");

-- Treasure-dimension recompute selects winners by time window.
CREATE INDEX "treasure_winners_selectedAt_idx"
    ON "treasure_winners" ("selectedAt");
```

Note for the implementer: on a large production table these should be created `CONCURRENTLY`. Prisma migrations run inside a transaction, which forbids `CONCURRENTLY`, so if the user's `gift_transactions` is large they may prefer to create these by hand outside the migration. **Flag this to the user; do not decide it for them.**

- [ ] **Step 3: Regenerate the client**

```bash
pnpm prisma:format && pnpm prisma:generate
```

Expected: exit 0 on both.

- [ ] **Step 4: Write the failing repository test**

Create `src/modules/video-rooms/repositories/video-room-ranking.repository.spec.ts`:

```ts
import { VideoRoomRankingRepository } from './video-room-ranking.repository';

const KEY = { scope: 'g', dimension: 'hosts', period: 'daily', dateKey: '20260722' };
const WINDOW = { start: new Date('2026-07-22T00:00:00Z'), end: new Date('2026-07-23T00:00:00Z') };

describe('VideoRoomRankingRepository', () => {
  let prisma: any;
  let repo: VideoRoomRankingRepository;

  beforeEach(() => {
    prisma = {
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'u1', country: 'IN' }]) },
      userProfile: { findMany: jest.fn().mockResolvedValue([{ userId: 'u1', city: 'c9' }]) },
      videoRoomRankingSnapshot: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        deleteMany: jest.fn().mockResolvedValue({ count: 5 }),
      },
      videoRoomLeaderboardSnapshot: {
        upsert: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      videoRoomRankingAggregationLog: {
        create: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
      giftTransaction: { groupBy: jest.fn().mockResolvedValue([]) },
      videoRoomPkBattle: { findMany: jest.fn().mockResolvedValue([]) },
      videoRoomPkParticipant: { findMany: jest.fn().mockResolvedValue([]) },
      treasureWinner: { groupBy: jest.fn().mockResolvedValue([]) },
      videoRoomStatistics: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    repo = new VideoRoomRankingRepository(prisma);
  });

  describe('findUserGeo', () => {
    it('joins country from user and city from profile', async () => {
      await expect(repo.findUserGeo(['u1'])).resolves.toEqual([
        { userId: 'u1', country: 'IN', city: 'c9' },
      ]);
    });

    it('returns null city when the user has no profile row', async () => {
      prisma.userProfile.findMany.mockResolvedValue([]);
      await expect(repo.findUserGeo(['u1'])).resolves.toEqual([
        { userId: 'u1', country: 'IN', city: null },
      ]);
    });

    it('short-circuits on an empty id list', async () => {
      await expect(repo.findUserGeo([])).resolves.toEqual([]);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });
  });

  describe('saveRankingSnapshots', () => {
    it('skips duplicates so a replayed snapshot is a no-op', async () => {
      await expect(repo.saveRankingSnapshots([{ scope: 'g' } as never])).resolves.toBe(2);
      expect(prisma.videoRoomRankingSnapshot.createMany).toHaveBeenCalledWith({
        data: [{ scope: 'g' }],
        skipDuplicates: true,
      });
    });

    it('writes nothing for an empty batch', async () => {
      await expect(repo.saveRankingSnapshots([])).resolves.toBe(0);
      expect(prisma.videoRoomRankingSnapshot.createMany).not.toHaveBeenCalled();
    });
  });

  describe('beginAggregation', () => {
    it('claims the window when no log row exists', async () => {
      await expect(repo.beginAggregation(KEY, WINDOW.start, WINDOW.end)).resolves.toBe('CLAIMED');
      expect(prisma.videoRoomRankingAggregationLog.upsert).toHaveBeenCalled();
    });

    it('refuses to re-run a window that already succeeded', async () => {
      prisma.videoRoomRankingAggregationLog.findUnique.mockResolvedValue({ status: 'SUCCEEDED' });
      await expect(repo.beginAggregation(KEY, WINDOW.start, WINDOW.end)).resolves.toBe(
        'ALREADY_SUCCEEDED',
      );
      expect(prisma.videoRoomRankingAggregationLog.upsert).not.toHaveBeenCalled();
    });

    it('re-claims a window whose previous run FAILED', async () => {
      prisma.videoRoomRankingAggregationLog.findUnique.mockResolvedValue({ status: 'FAILED' });
      await expect(repo.beginAggregation(KEY, WINDOW.start, WINDOW.end)).resolves.toBe('CLAIMED');
    });

    it('re-claims a window left RUNNING by a crashed worker', async () => {
      prisma.videoRoomRankingAggregationLog.findUnique.mockResolvedValue({ status: 'RUNNING' });
      await expect(repo.beginAggregation(KEY, WINDOW.start, WINDOW.end)).resolves.toBe('CLAIMED');
    });
  });

  describe('aggregateGiftCoinsBySender', () => {
    it('groups VIDEO_ROOM gifts in the window by sender', async () => {
      prisma.giftTransaction.groupBy.mockResolvedValue([
        { senderId: 'u1', _sum: { totalCoinValue: 500n }, _count: { _all: 3 } },
      ]);
      await expect(repo.aggregateGiftCoinsBySender(WINDOW)).resolves.toEqual([
        { userId: 'u1', coins: 500n, gifts: 3 },
      ]);
      const args = prisma.giftTransaction.groupBy.mock.calls[0][0];
      expect(args.where.contextType).toBe('VIDEO_ROOM');
      expect(args.where.status).toBe('COMPLETED');
      expect(args.where.createdAt).toEqual({ gte: WINDOW.start, lt: WINDOW.end });
      expect(args.where.contextId).toBeUndefined();
    });

    it('scopes to one room when a roomId is given', async () => {
      await repo.aggregateGiftCoinsBySender(WINDOW, 'room-1');
      expect(prisma.giftTransaction.groupBy.mock.calls[0][0].where.contextId).toBe('room-1');
    });

    it('coerces a null sum to zero rather than emitting null coins', async () => {
      prisma.giftTransaction.groupBy.mockResolvedValue([
        { senderId: 'u1', _sum: { totalCoinValue: null }, _count: { _all: 0 } },
      ]);
      await expect(repo.aggregateGiftCoinsBySender(WINDOW)).resolves.toEqual([
        { userId: 'u1', coins: 0n, gifts: 0 },
      ]);
    });
  });

  describe('pruneSnapshots', () => {
    it('deletes only the given period older than the cutoff', async () => {
      const cutoff = new Date('2026-01-01T00:00:00Z');
      await expect(repo.pruneSnapshots('hourly', cutoff)).resolves.toBe(5);
      expect(prisma.videoRoomRankingSnapshot.deleteMany).toHaveBeenCalledWith({
        where: { period: 'hourly', createdAt: { lt: cutoff } },
      });
    });
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

```bash
pnpm test -- src/modules/video-rooms/repositories/video-room-ranking.repository.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 6: Implement the repository**

Create `src/modules/video-rooms/repositories/video-room-ranking.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import {
  GiftContextType,
  GiftTxnStatus,
  Prisma,
  VideoRoomPkStatus,
  type VideoRoomLeaderboardSnapshot,
  type VideoRoomRankingSnapshot,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface AggregationWindow {
  start: Date;
  end: Date;
}

export interface RankingLadderKey {
  scope: string;
  dimension: string;
  period: string;
  dateKey: string;
}

export interface LeaderboardSnapshotInput extends RankingLadderKey {
  entries: Prisma.InputJsonValue;
  totalEntries: number;
}

export interface AggregationStats {
  sourceRows: number;
  entriesWritten: number;
  durationMs: number;
}

/**
 * The only place VR-13 touches Prisma (enforced by dependency-cruiser).
 *
 * Two distinct responsibilities live here and are kept visually separate: the
 * three VR-13 tables, and read-only aggregate queries over OTHER modules'
 * source tables. The latter is what makes the recompute authoritative — it
 * recounts from gift_transactions / PK / treasure rather than trusting an
 * accumulated Redis score — and it is deliberately read-only: VR-13 never
 * writes another domain's table.
 */
@Injectable()
export class VideoRoomRankingRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ================= geography =================

  /**
   * Country lives on `User`, city on `UserProfile` — two tables, so two queries
   * joined in memory. Done as a single `$transaction` so both reads see one
   * snapshot, and batched by id because this is called with a whole ladder's
   * worth of users during recompute.
   */
  async findUserGeo(
    userIds: string[],
  ): Promise<{ userId: string; country: string | null; city: string | null }[]> {
    if (userIds.length === 0) return [];
    const [users, profiles] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, country: true },
      }),
      this.prisma.userProfile.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, city: true },
      }),
    ]);
    const cityById = new Map(profiles.map((p) => [p.userId, p.city]));
    return users.map((u) => ({
      userId: u.id,
      country: u.country ?? null,
      city: cityById.get(u.id) ?? null,
    }));
  }

  // ================= ranking snapshots =================

  /**
   * `skipDuplicates` against the (scope,dimension,period,dateKey,targetId)
   * unique key is what makes a replayed snapshot job a no-op instead of a
   * constraint violation.
   */
  async saveRankingSnapshots(
    rows: Prisma.VideoRoomRankingSnapshotCreateManyInput[],
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const { count } = await this.prisma.videoRoomRankingSnapshot.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return count;
  }

  async findRankingSnapshots(
    scope: string,
    dimension: string,
    period: string,
    dateKey: string,
    skip: number,
    take: number,
  ): Promise<[VideoRoomRankingSnapshot[], number]> {
    const where = { scope, dimension, period, dateKey };
    return this.prisma.$transaction([
      this.prisma.videoRoomRankingSnapshot.findMany({
        where,
        skip,
        take,
        orderBy: { rank: 'asc' },
      }),
      this.prisma.videoRoomRankingSnapshot.count({ where }),
    ]);
  }

  /** One entity's positions over time — the "my ranking history" read. */
  findTargetHistory(
    targetId: string,
    dimension: string,
    period: string,
    take: number,
  ): Promise<VideoRoomRankingSnapshot[]> {
    return this.prisma.videoRoomRankingSnapshot.findMany({
      where: { targetId, dimension, period },
      orderBy: { dateKey: 'desc' },
      take,
    });
  }

  async pruneSnapshots(period: string, olderThan: Date): Promise<number> {
    const { count } = await this.prisma.videoRoomRankingSnapshot.deleteMany({
      where: { period, createdAt: { lt: olderThan } },
    });
    return count;
  }

  // ================= leaderboard snapshots =================

  /** Upsert, not create: a re-run must overwrite its own ladder, not collide. */
  async upsertLeaderboardSnapshot(input: LeaderboardSnapshotInput): Promise<void> {
    const { scope, dimension, period, dateKey, entries, totalEntries } = input;
    await this.prisma.videoRoomLeaderboardSnapshot.upsert({
      where: { scope_dimension_period_dateKey: { scope, dimension, period, dateKey } },
      create: { scope, dimension, period, dateKey, entries, totalEntries },
      update: { entries, totalEntries, capturedAt: new Date() },
    });
  }

  findLeaderboardSnapshot(
    scope: string,
    dimension: string,
    period: string,
    dateKey: string,
  ): Promise<VideoRoomLeaderboardSnapshot | null> {
    return this.prisma.videoRoomLeaderboardSnapshot.findUnique({
      where: { scope_dimension_period_dateKey: { scope, dimension, period, dateKey } },
    });
  }

  // ================= aggregation log (idempotency) =================

  /**
   * Claim a window for recompute.
   *
   * Only a SUCCEEDED row blocks a re-run. FAILED is obviously retryable; so is
   * RUNNING, because a RUNNING row with no `finishedAt` is indistinguishable
   * from a worker that was killed mid-job — and refusing those would leave a
   * window permanently un-aggregated with no operator signal. The fleet-wide
   * lock the job takes before calling this is what prevents two LIVE workers
   * from overlapping; this guard is about redelivery, not concurrency.
   */
  async beginAggregation(
    key: RankingLadderKey,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<'CLAIMED' | 'ALREADY_SUCCEEDED'> {
    const where = { scope_dimension_period_dateKey: { ...key } };
    const existing = await this.prisma.videoRoomRankingAggregationLog.findUnique({ where });
    if (existing?.status === 'SUCCEEDED') return 'ALREADY_SUCCEEDED';

    await this.prisma.videoRoomRankingAggregationLog.upsert({
      where,
      create: { ...key, status: 'RUNNING', windowStart, windowEnd },
      update: {
        status: 'RUNNING',
        windowStart,
        windowEnd,
        startedAt: new Date(),
        finishedAt: null,
        error: null,
      },
    });
    return 'CLAIMED';
  }

  async completeAggregation(key: RankingLadderKey, stats: AggregationStats): Promise<void> {
    await this.prisma.videoRoomRankingAggregationLog.update({
      where: { scope_dimension_period_dateKey: { ...key } },
      data: { status: 'SUCCEEDED', ...stats, finishedAt: new Date(), error: null },
    });
  }

  async failAggregation(key: RankingLadderKey, error: string): Promise<void> {
    await this.prisma.videoRoomRankingAggregationLog.update({
      where: { scope_dimension_period_dateKey: { ...key } },
      data: { status: 'FAILED', error: error.slice(0, 1000), finishedAt: new Date() },
    });
  }

  // ================= source aggregates (read-only, other domains) =================

  private giftWhere(window: AggregationWindow, roomId?: string): Prisma.GiftTransactionWhereInput {
    return {
      contextType: GiftContextType.VIDEO_ROOM,
      status: GiftTxnStatus.COMPLETED,
      createdAt: { gte: window.start, lt: window.end },
      ...(roomId ? { contextId: roomId } : {}),
    };
  }

  async aggregateGiftCoinsBySender(
    window: AggregationWindow,
    roomId?: string,
  ): Promise<{ userId: string; coins: bigint; gifts: number }[]> {
    const rows = await this.prisma.giftTransaction.groupBy({
      by: ['senderId'],
      where: this.giftWhere(window, roomId),
      _sum: { totalCoinValue: true },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      userId: r.senderId,
      coins: r._sum.totalCoinValue ?? 0n,
      gifts: r._sum.totalCoinValue === null ? 0 : r._count._all,
    }));
  }

  async aggregateGiftCoinsByReceiver(
    window: AggregationWindow,
    roomId?: string,
  ): Promise<{ userId: string; coins: bigint; gifts: number }[]> {
    const rows = await this.prisma.giftTransaction.groupBy({
      by: ['receiverId'],
      where: this.giftWhere(window, roomId),
      _sum: { totalCoinValue: true },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      userId: r.receiverId,
      coins: r._sum.totalCoinValue ?? 0n,
      gifts: r._sum.totalCoinValue === null ? 0 : r._count._all,
    }));
  }

  /** `contextId` IS the room id for VIDEO_ROOM gifts. */
  async aggregateGiftCoinsByRoom(
    window: AggregationWindow,
  ): Promise<{ roomId: string; coins: bigint; gifts: number }[]> {
    const rows = await this.prisma.giftTransaction.groupBy({
      by: ['contextId'],
      where: this.giftWhere(window),
      _sum: { totalCoinValue: true },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      roomId: r.contextId,
      coins: r._sum.totalCoinValue ?? 0n,
      gifts: r._sum.totalCoinValue === null ? 0 : r._count._all,
    }));
  }

  /**
   * PK outcomes per user for battles COMPLETED in the window. Read as two
   * queries — battles, then their participants — because a participant's win
   * or loss is only knowable from its battle's `winningTeamId`, and Prisma
   * cannot express that comparison in a groupBy.
   */
  async aggregatePkOutcomes(
    window: AggregationWindow,
  ): Promise<{ userId: string; wins: number; losses: number; score: bigint; giftCoins: bigint }[]> {
    const battles = await this.prisma.videoRoomPkBattle.findMany({
      where: {
        status: VideoRoomPkStatus.COMPLETED,
        completedAt: { gte: window.start, lt: window.end },
      },
      select: { id: true, winningTeamId: true, isDraw: true },
    });
    if (battles.length === 0) return [];

    const winnerByBattle = new Map(battles.map((b) => [b.id, b.isDraw ? null : b.winningTeamId]));
    const participants = await this.prisma.videoRoomPkParticipant.findMany({
      where: { battleId: { in: battles.map((b) => b.id) } },
      select: { battleId: true, userId: true, teamId: true, score: true },
    });

    const byUser = new Map<
      string,
      { userId: string; wins: number; losses: number; score: bigint; giftCoins: bigint }
    >();
    for (const p of participants) {
      const entry = byUser.get(p.userId) ?? {
        userId: p.userId,
        wins: 0,
        losses: 0,
        score: 0n,
        giftCoins: 0n,
      };
      const winningTeamId = winnerByBattle.get(p.battleId);
      // A draw counts as neither a win nor a loss — winningTeamId is null.
      if (winningTeamId !== null && winningTeamId !== undefined) {
        if (winningTeamId === p.teamId) entry.wins += 1;
        else entry.losses += 1;
      }
      entry.score += p.score;
      entry.giftCoins += p.score; // PK score is gift-derived; see VideoRoomPkScoreEngine.
      byUser.set(p.userId, entry);
    }
    return [...byUser.values()];
  }

  async aggregateTreasureWinnings(
    window: AggregationWindow,
  ): Promise<{ userId: string; coins: bigint; events: number }[]> {
    const rows = await this.prisma.treasureWinner.groupBy({
      by: ['userId'],
      where: { selectedAt: { gte: window.start, lt: window.end } },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      userId: r.userId,
      coins: r._sum.amount ?? 0n,
      events: r._count._all,
    }));
  }

  findRoomStatistics(roomIds: string[]): Promise<
    { roomId: string; peakViewers: number; avgWatchTimeSeconds: number; totalPkCount: number }[]
  > {
    if (roomIds.length === 0) return Promise.resolve([]);
    return this.prisma.videoRoomStatistics.findMany({
      where: { roomId: { in: roomIds } },
      select: {
        roomId: true,
        peakViewers: true,
        avgWatchTimeSeconds: true,
        totalPkCount: true,
      },
    });
  }
}
```

- [ ] **Step 7: Run the repository test, then re-run Task 8's**

```bash
pnpm test -- src/modules/video-rooms/repositories/video-room-ranking.repository.spec.ts
pnpm test -- src/modules/video-rooms/services/video-room-ranking-scope.resolver.spec.ts
pnpm lint
pnpm boundaries
```

Expected: both suites PASS; lint and boundaries exit 0. `boundaries` passing confirms no Prisma import leaked into a service.

- [ ] **Step 8: Report and stop**

Explicitly flag the `CONCURRENTLY` caveat from Step 2 to the user. **Do not commit.**

---

## Task 10: Domain events

**Files:**
- Create: `src/modules/video-rooms/events/video-room-ranking.events.ts`
- Test: `src/modules/video-rooms/events/video-room-ranking.events.spec.ts`
- Modify: `src/modules/video-rooms/events/index.ts` (add one export line)

**Interfaces:**
- Consumes: `DomainEvent` from `src/common/events`.
- Produces: `VIDEO_ROOM_RANKING_EVENTS`, `interface RankingEntryView`, and nine event classes: `RankingUpdatedEvent`, `LeaderboardUpdatedEvent`, `HostRankingUpdatedEvent`, `RoomRankingUpdatedEvent`, `GifterRankingUpdatedEvent`, `PKRankingUpdatedEvent`, `TreasureRankingUpdatedEvent`, `RankingAggregatedEvent`, `RankingSnapshotCreatedEvent`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/events/video-room-ranking.events.spec.ts`:

```ts
import {
  HostRankingUpdatedEvent,
  RankingAggregatedEvent,
  RankingUpdatedEvent,
  VIDEO_ROOM_RANKING_EVENTS,
} from './video-room-ranking.events';

describe('VR-13 ranking events', () => {
  it('namespaces every event under video_room.ranking / video_room.leaderboard', () => {
    const names = Object.values(VIDEO_ROOM_RANKING_EVENTS);
    expect(names).toHaveLength(9);
    expect(new Set(names).size).toBe(9);
    expect(
      names.every(
        (n) => n.startsWith('video_room.ranking.') || n.startsWith('video_room.leaderboard.'),
      ),
    ).toBe(true);
  });

  it('binds each class to its own bus name', () => {
    const base = { scope: 'g', dimension: 'hosts', period: 'daily', dateKey: '20260722' };
    expect(new RankingUpdatedEvent({ ...base, entries: [] }).name).toBe(
      VIDEO_ROOM_RANKING_EVENTS.RANKING_UPDATED,
    );
    expect(new HostRankingUpdatedEvent({ ...base, entries: [] }).name).toBe(
      VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED,
    );
  });

  it('carries an eventId and occurredAt from DomainEvent', () => {
    const e = new RankingAggregatedEvent({
      scope: 'g',
      dimension: 'hosts',
      period: 'daily',
      dateKey: '20260722',
      entriesWritten: 12,
      sourceRows: 340,
      durationMs: 88,
    });
    expect(e.eventId).toEqual(expect.any(String));
    expect(Date.parse(e.occurredAt)).not.toBeNaN();
  });

  it('keeps the payload plain-serialisable — no BigInt crosses the bus', () => {
    const e = new RankingUpdatedEvent({
      scope: 'g',
      dimension: 'hosts',
      period: 'daily',
      dateKey: '20260722',
      entries: [{ targetId: 'u1', rank: 1, score: 900 }],
    });
    expect(() => JSON.stringify(e.payload)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm test -- src/modules/video-rooms/events/video-room-ranking.events.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the events**

Create `src/modules/video-rooms/events/video-room-ranking.events.ts`:

```ts
import { DomainEvent } from 'src/common/events';

/**
 * VR-13 ranking events.
 *
 * Deliberately NOT re-declared here: `gift.sent`, `video_room.pk.*` and
 * `video_room.treasure.*` are published by their owning engines and CONSUMED by
 * this module. Re-publishing any of them would fire every existing listener a
 * second time — notifications, EXP, the platform rankings module and the socket
 * bridges all subscribe to them. These nine names are outputs only.
 */
export const VIDEO_ROOM_RANKING_EVENTS = {
  RANKING_UPDATED: 'video_room.ranking.updated',
  LEADERBOARD_UPDATED: 'video_room.leaderboard.updated',
  HOST_RANKING_UPDATED: 'video_room.ranking.host_updated',
  ROOM_RANKING_UPDATED: 'video_room.ranking.room_updated',
  GIFTER_RANKING_UPDATED: 'video_room.ranking.gifter_updated',
  PK_RANKING_UPDATED: 'video_room.ranking.pk_updated',
  TREASURE_RANKING_UPDATED: 'video_room.ranking.treasure_updated',
  AGGREGATED: 'video_room.ranking.aggregated',
  SNAPSHOT_CREATED: 'video_room.ranking.snapshot_created',
} as const;

/**
 * One ladder position as broadcast. `score` is a number, not BigInt: this
 * crosses the wire and BigInt has no JSON representation.
 */
export interface RankingEntryView {
  targetId: string;
  rank: number;
  score: number;
}

/** Every ranking event is addressable by its ladder coordinates. */
export interface RankingEventBase {
  scope: string;
  dimension: string;
  period: string;
  dateKey: string;
  /** Present when the ladder is room-scoped — the socket bridge routes on it. */
  roomId?: string;
  /** The originating HTTP request id, when a request caused this. */
  requestId?: string;
}

export type RankingMovementPayload = RankingEventBase & { entries: RankingEntryView[] };

export class RankingUpdatedEvent extends DomainEvent<RankingMovementPayload> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.RANKING_UPDATED;
}

export class LeaderboardUpdatedEvent extends DomainEvent<RankingMovementPayload> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.LEADERBOARD_UPDATED;
}

export class HostRankingUpdatedEvent extends DomainEvent<RankingMovementPayload> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED;
}

export class RoomRankingUpdatedEvent extends DomainEvent<RankingMovementPayload> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.ROOM_RANKING_UPDATED;
}

export class GifterRankingUpdatedEvent extends DomainEvent<RankingMovementPayload> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.GIFTER_RANKING_UPDATED;
}

export class PKRankingUpdatedEvent extends DomainEvent<RankingMovementPayload> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.PK_RANKING_UPDATED;
}

export class TreasureRankingUpdatedEvent extends DomainEvent<RankingMovementPayload> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.TREASURE_RANKING_UPDATED;
}

/** A recompute finished. Consumed by the metrics and audit listeners. */
export class RankingAggregatedEvent extends DomainEvent<
  RankingEventBase & { entriesWritten: number; sourceRows: number; durationMs: number }
> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.AGGREGATED;
}

/** A ladder was persisted at period close. */
export class RankingSnapshotCreatedEvent extends DomainEvent<
  RankingEventBase & { entriesWritten: number; totalEntries: number; durationMs: number }
> {
  readonly name = VIDEO_ROOM_RANKING_EVENTS.SNAPSHOT_CREATED;
}
```

- [ ] **Step 4: Export from the barrel**

Append to `src/modules/video-rooms/events/index.ts`:

```ts
export * from './video-room-ranking.events';
```

- [ ] **Step 5: Run the test**

```bash
pnpm test -- src/modules/video-rooms/events/video-room-ranking.events.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Report and stop.** **Do not commit.**

---

## Task 11: VideoRoomRankingService — the write path

**Files:**
- Create: `src/modules/video-rooms/services/video-room-ranking.service.ts`
- Test: `src/modules/video-rooms/services/video-room-ranking.service.spec.ts`

**Interfaces:**
- Consumes: `LeaderboardStore` (Task 2), `RankingPeriodResolver` (Task 1), `VideoRoomRankingScoreEngine` (Task 7), `VideoRoomRankingScopeResolver` (Task 8), constants + config (Task 6), events (Task 10), `EVENT_BUS`.
- Produces `class VideoRoomRankingService` with:
  - `recordGift(input: GiftRankingInput): Promise<void>`
  - `recordGiftRefund(input: GiftRankingInput): Promise<void>`
  - `recordPkResult(input: PkRankingInput): Promise<void>`
  - `recordTreasureWin(input: TreasureRankingInput): Promise<void>`
  - `recordRoomActivity(input: RoomActivityInput): Promise<void>`
  - and the four input interfaces above.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/services/video-room-ranking.service.spec.ts`:

```ts
import { VideoRoomRankingService } from './video-room-ranking.service';
import { RankingPeriodResolver } from 'src/modules/rankings/services/ranking-period.resolver';
import { VideoRoomRankingScoreEngine } from './video-room-ranking-score.engine';

const AT = new Date('2026-07-22T14:35:00.000Z');

const giftInput = (over = {}) => ({
  transactionId: 'txn-1',
  roomId: 'room-1',
  senderId: 'sender-1',
  receiverId: 'receiver-1',
  totalCoinValue: 100,
  quantity: 1,
  receiverIsSeated: true,
  occurredAt: AT,
  ...over,
});

describe('VideoRoomRankingService', () => {
  let store: {
    key: jest.Mock;
    incrementMany: jest.Mock;
    markSeen: jest.Mock;
    bumpVersion: jest.Mock;
    top: jest.Mock;
  };
  let scopes: { scopesFor: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomRankingService;

  const config = { get: () => ({}) } as never;

  beforeEach(() => {
    store = {
      key: jest.fn(
        (ns, scope, dim, period, dateKey) => `${ns}:{${scope}|${dim}}:${period}:${dateKey}`,
      ),
      incrementMany: jest.fn().mockResolvedValue(undefined),
      markSeen: jest.fn().mockResolvedValue(true),
      bumpVersion: jest.fn().mockResolvedValue(1),
      top: jest.fn().mockResolvedValue([{ member: 'sender-1', score: 100 }]),
    };
    scopes = { scopesFor: jest.fn().mockResolvedValue(['g', 'c:IN', 'r:room-1']) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };

    service = new VideoRoomRankingService(
      config,
      store as never,
      new RankingPeriodResolver(),
      new VideoRoomRankingScoreEngine(config),
      scopes as never,
      bus as never,
    );
  });

  describe('recordGift', () => {
    it('claims the transaction exactly once before writing', async () => {
      await service.recordGift(giftInput());
      expect(store.markSeen).toHaveBeenCalledWith('vrank', 'gift', 'txn-1', expect.any(Number));
    });

    it('writes nothing at all when the transaction was already applied', async () => {
      store.markSeen.mockResolvedValue(false);
      await service.recordGift(giftInput());
      expect(store.incrementMany).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('never writes a rankings:* key — that namespace belongs to the platform module', async () => {
      await service.recordGift(giftInput());
      const keys = store.incrementMany.mock.calls[0][0].map((i: { key: string }) => i.key);
      expect(keys.every((k: string) => k.startsWith('vrank:'))).toBe(true);
      expect(keys.some((k: string) => k.startsWith('rankings:'))).toBe(false);
    });

    it('materialises exactly the five hot periods per scope+dimension', async () => {
      await service.recordGift(giftInput());
      const keys: string[] = store.incrementMany.mock.calls[0][0].map(
        (i: { key: string }) => i.key,
      );
      const gifterGlobal = keys.filter((k) => k.includes('{g|gifters}'));
      expect(gifterGlobal.sort()).toEqual(
        [
          'vrank:{g|gifters}:alltime:alltime',
          'vrank:{g|gifters}:daily:20260722',
          'vrank:{g|gifters}:hourly:2026072214',
          'vrank:{g|gifters}:monthly:202607',
          'vrank:{g|gifters}:weekly:2026W30',
        ].sort(),
      );
    });

    it('never materialises a derived period on the hot path', async () => {
      await service.recordGift(giftInput());
      const keys: string[] = store.incrementMany.mock.calls[0][0].map(
        (i: { key: string }) => i.key,
      );
      expect(keys.some((k) => k.includes(':quarterly:') || k.includes(':yearly:'))).toBe(false);
    });

    it('credits the sender as gifter and the receiver as receiver', async () => {
      await service.recordGift(giftInput());
      const incs = store.incrementMany.mock.calls[0][0];
      const gifter = incs.find((i: { key: string }) => i.key.includes('{g|gifters}'));
      const receiver = incs.find((i: { key: string }) => i.key.includes('{g|receivers}'));
      expect(gifter.member).toBe('sender-1');
      expect(gifter.delta).toBe(100);
      expect(receiver.member).toBe('receiver-1');
      expect(receiver.delta).toBe(100);
    });

    it('credits the hosts ladder only when the receiver holds a seat', async () => {
      await service.recordGift(giftInput());
      expect(
        store.incrementMany.mock.calls[0][0].some((i: { key: string }) => i.key.includes('|hosts}')),
      ).toBe(true);

      store.incrementMany.mockClear();
      await service.recordGift(giftInput({ transactionId: 'txn-2', receiverIsSeated: false }));
      expect(
        store.incrementMany.mock.calls[0][0].some((i: { key: string }) => i.key.includes('|hosts}')),
      ).toBe(false);
    });

    it('credits the rooms ladder against the room id, not a user id', async () => {
      await service.recordGift(giftInput());
      const room = store.incrementMany.mock.calls[0][0].find((i: { key: string }) =>
        i.key.includes('|rooms}'),
      );
      expect(room.member).toBe('room-1');
    });

    it('TTLs room-scoped keys so a dead room evicts, and never TTLs global ones', async () => {
      await service.recordGift(giftInput());
      const incs = store.incrementMany.mock.calls[0][0];
      const roomScoped = incs.filter((i: { key: string }) => i.key.includes('{r:room-1|'));
      const globalScoped = incs.filter((i: { key: string }) => i.key.includes('{g|'));
      expect(roomScoped.every((i: { ttlSeconds?: number }) => i.ttlSeconds === 604_800)).toBe(true);
      expect(globalScoped.every((i: { ttlSeconds?: number }) => i.ttlSeconds === undefined)).toBe(
        true,
      );
    });

    it('bumps the ladder version so cached pages invalidate', async () => {
      await service.recordGift(giftInput());
      expect(store.bumpVersion).toHaveBeenCalled();
    });

    it('publishes a movement event carrying the room id for socket routing', async () => {
      await service.recordGift(giftInput());
      expect(bus.publish).toHaveBeenCalled();
      const published = bus.publish.mock.calls.map((c) => c[0].payload);
      expect(published.some((p) => p.roomId === 'room-1')).toBe(true);
    });

    it('is a no-op when the engine is disabled', async () => {
      const disabled = new VideoRoomRankingService(
        { get: () => ({ enabled: 'false' }) } as never,
        store as never,
        new RankingPeriodResolver(),
        new VideoRoomRankingScoreEngine({ get: () => ({}) } as never),
        scopes as never,
        bus as never,
      );
      await disabled.recordGift(giftInput());
      expect(store.incrementMany).not.toHaveBeenCalled();
    });

    it('issues one batched write rather than one per key', async () => {
      await service.recordGift(giftInput());
      expect(store.incrementMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('recordGiftRefund', () => {
    it('applies a negative delta under its own dedupe marker', async () => {
      await service.recordGiftRefund(giftInput());
      expect(store.markSeen).toHaveBeenCalledWith(
        'vrank',
        'gift-refund',
        'txn-1',
        expect.any(Number),
      );
      const incs = store.incrementMany.mock.calls[0][0];
      expect(incs.every((i: { delta: number }) => i.delta <= 0)).toBe(true);
    });
  });

  describe('recordPkResult', () => {
    it('scores a winner above a loser on the pk ladder', async () => {
      await service.recordPkResult({
        battleId: 'b1',
        roomId: 'room-1',
        occurredAt: AT,
        outcomes: [
          { userId: 'w', won: true, lost: false, score: 100 },
          { userId: 'l', won: false, lost: true, score: 100 },
        ],
      });
      const incs = store.incrementMany.mock.calls[0][0];
      const w = incs.find((i: { member: string; key: string }) => i.member === 'w' && i.key.includes('|pk}'));
      const l = incs.find((i: { member: string; key: string }) => i.member === 'l' && i.key.includes('|pk}'));
      expect(w.delta).toBeGreaterThan(l.delta);
    });

    it('dedupes on the battle id', async () => {
      await service.recordPkResult({ battleId: 'b1', roomId: 'r', occurredAt: AT, outcomes: [] });
      expect(store.markSeen).toHaveBeenCalledWith('vrank', 'pk', 'b1', expect.any(Number));
    });
  });

  describe('recordTreasureWin', () => {
    it('dedupes on the reward id and credits the treasure ladder', async () => {
      await service.recordTreasureWin({
        rewardId: 'rw-1',
        roomId: 'room-1',
        userId: 'u1',
        amount: 250,
        occurredAt: AT,
      });
      expect(store.markSeen).toHaveBeenCalledWith('vrank', 'treasure', 'rw-1', expect.any(Number));
      const inc = store.incrementMany.mock.calls[0][0].find((i: { key: string }) =>
        i.key.includes('|treasure}'),
      );
      expect(inc.member).toBe('u1');
      expect(inc.delta).toBe(250);
    });
  });

  it('swallows a store failure — a ranking write must never fail a gift', async () => {
    store.incrementMany.mockRejectedValue(new Error('redis down'));
    await expect(service.recordGift(giftInput())).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm test -- src/modules/video-rooms/services/video-room-ranking.service.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the write path**

Create `src/modules/video-rooms/services/video-room-ranking.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import type { LeaderboardIncrement } from 'src/modules/rankings/services/leaderboard-store.service';
import { LeaderboardStore } from 'src/modules/rankings/services/leaderboard-store.service';
import {
  RankingPeriodResolver,
  type RankingPeriodName,
} from 'src/modules/rankings/services/ranking-period.resolver';
import {
  loadVideoRoomRankingConfig,
  type VideoRoomRankingConfig,
} from '../config/video-room-ranking.config';
import {
  VideoRoomRankingDimension,
  VIDEO_ROOM_RANKING_HOT_PERIODS,
  VIDEO_ROOM_RANKING_NAMESPACE,
  parseScope,
  scopeRoom,
} from '../constants/video-room-ranking.constants';
import {
  GifterRankingUpdatedEvent,
  HostRankingUpdatedEvent,
  PKRankingUpdatedEvent,
  RankingUpdatedEvent,
  RoomRankingUpdatedEvent,
  TreasureRankingUpdatedEvent,
} from '../events/video-room-ranking.events';
import { VideoRoomRankingScopeResolver } from './video-room-ranking-scope.resolver';
import { VideoRoomRankingScoreEngine } from './video-room-ranking-score.engine';

export interface GiftRankingInput {
  transactionId: string;
  roomId: string;
  senderId: string;
  receiverId: string;
  totalCoinValue: number;
  quantity: number;
  /** Only a seated receiver is a "host" for ranking purposes. */
  receiverIsSeated: boolean;
  occurredAt: Date;
}

export interface PkRankingInput {
  battleId: string;
  roomId: string;
  occurredAt: Date;
  outcomes: { userId: string; won: boolean; lost: boolean; score: number }[];
}

export interface TreasureRankingInput {
  rewardId: string;
  roomId: string;
  userId: string;
  amount: number;
  occurredAt: Date;
}

export interface RoomActivityInput {
  /** Natural id for dedupe — a session id or a monitor tick id. */
  activityId: string;
  roomId: string;
  occurredAt: Date;
  peakViewers?: number;
  avgWatchSeconds?: number;
  pkCount?: number;
  treasureCount?: number;
}

/** One entity's movement on one dimension, before scope fan-out. */
interface DimensionDelta {
  dimension: VideoRoomRankingDimension;
  member: string;
  delta: number;
}

/**
 * The VR-13 write path: turn a domain event into ZSET increments.
 *
 * Three invariants hold for every method here.
 *
 * 1. **Dedupe first.** Every source event has a natural id; the first thing any
 *    record* method does is claim it. A redelivered gift must not move a ladder
 *    twice, and ZINCRBY has no idempotency of its own.
 *
 * 2. **One batched write.** A single gift touches 5 periods × up to 4 scopes ×
 *    up to 4 dimensions. Issued individually that is ~80 round trips on the hot
 *    path of every gift on the platform; issued as one pipeline it is one.
 *
 * 3. **Never throw.** Every method swallows and logs. The caller is a listener
 *    reacting to money that has ALREADY moved — a gift is delivered, a PK is
 *    settled, a treasure is paid. Throwing here cannot undo any of that; it can
 *    only poison the bus for the other subscribers. Anything lost is restored
 *    by the recompute pass.
 */
@Injectable()
export class VideoRoomRankingService {
  private readonly logger = new Logger(VideoRoomRankingService.name);
  private readonly config: VideoRoomRankingConfig;
  private readonly ns = VIDEO_ROOM_RANKING_NAMESPACE;

  constructor(
    config: ConfigService,
    private readonly store: LeaderboardStore,
    private readonly periods: RankingPeriodResolver,
    private readonly scoring: VideoRoomRankingScoreEngine,
    private readonly scopes: VideoRoomRankingScopeResolver,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {
    this.config = loadVideoRoomRankingConfig(config);
  }

  async recordGift(input: GiftRankingInput): Promise<void> {
    await this.record('gift', input.transactionId, input.senderId, input.roomId, input.occurredAt, () =>
      this.giftDeltas(input, 1),
    );
  }

  /**
   * A refund reverses a gift. It carries its OWN dedupe marker rather than
   * reusing the gift's: the gift marker is already claimed, so sharing it would
   * make every refund a silent no-op.
   */
  async recordGiftRefund(input: GiftRankingInput): Promise<void> {
    await this.record(
      'gift-refund',
      input.transactionId,
      input.senderId,
      input.roomId,
      input.occurredAt,
      () => this.giftDeltas(input, -1),
    );
  }

  private giftDeltas(input: GiftRankingInput, sign: 1 | -1): DimensionDelta[] {
    const coins = input.totalCoinValue;
    const deltas: DimensionDelta[] = [
      {
        dimension: VideoRoomRankingDimension.GIFTERS,
        member: input.senderId,
        delta: sign * this.scoring.deltaFor(VideoRoomRankingDimension.GIFTERS, { coinsSpent: coins }),
      },
      {
        dimension: VideoRoomRankingDimension.RECEIVERS,
        member: input.receiverId,
        delta:
          sign *
          this.scoring.deltaFor(VideoRoomRankingDimension.RECEIVERS, { coinsReceived: coins }),
      },
      {
        dimension: VideoRoomRankingDimension.ROOMS,
        member: input.roomId,
        delta: sign * this.scoring.deltaFor(VideoRoomRankingDimension.ROOMS, { giftCoins: coins }),
      },
    ];

    // A receiver who is not on a seat is a spectator being tipped, not a host.
    if (input.receiverIsSeated) {
      deltas.push({
        dimension: VideoRoomRankingDimension.HOSTS,
        member: input.receiverId,
        delta:
          sign *
          this.scoring.deltaFor(VideoRoomRankingDimension.HOSTS, {
            coins,
            gifts: input.quantity,
          }),
      });
    }
    return deltas;
  }

  async recordPkResult(input: PkRankingInput): Promise<void> {
    await this.record('pk', input.battleId, undefined, input.roomId, input.occurredAt, () =>
      input.outcomes.map((o) => ({
        dimension: VideoRoomRankingDimension.PK,
        member: o.userId,
        delta: this.scoring.deltaFor(VideoRoomRankingDimension.PK, {
          wins: o.won ? 1 : 0,
          losses: o.lost ? 1 : 0,
          score: o.score,
        }),
      })),
    );
  }

  async recordTreasureWin(input: TreasureRankingInput): Promise<void> {
    await this.record('treasure', input.rewardId, input.userId, input.roomId, input.occurredAt, () => [
      {
        dimension: VideoRoomRankingDimension.TREASURE,
        member: input.userId,
        delta: this.scoring.deltaFor(VideoRoomRankingDimension.TREASURE, {
          treasureCoins: input.amount,
        }),
      },
    ]);
  }

  async recordRoomActivity(input: RoomActivityInput): Promise<void> {
    await this.record('room-activity', input.activityId, undefined, input.roomId, input.occurredAt, () => [
      {
        dimension: VideoRoomRankingDimension.ROOMS,
        member: input.roomId,
        delta: this.scoring.deltaFor(VideoRoomRankingDimension.ROOMS, {
          peakViewers: input.peakViewers,
          avgWatchSeconds: input.avgWatchSeconds,
          pkCount: input.pkCount,
          treasureCount: input.treasureCount,
        }),
      },
    ]);
  }

  /**
   * The shared pipeline: gate → dedupe → resolve scopes → expand to keys →
   * one batched write → bump versions → publish.
   *
   * `attributionUserId` is whose geography decides the country/city ladders.
   * For a gift that is the SENDER: a "top gifters in India" ladder ranks Indian
   * spenders, not gifts that happened to reach an Indian host. Events with no
   * single attributable user (a PK result, a room tick) pass `undefined` and
   * fan out to global + room only.
   */
  private async record(
    source: string,
    naturalId: string,
    attributionUserId: string | undefined,
    roomId: string,
    occurredAt: Date,
    buildDeltas: () => DimensionDelta[],
  ): Promise<void> {
    if (!this.config.enabled) return;

    try {
      const fresh = await this.store.markSeen(
        this.ns,
        source,
        naturalId,
        this.config.dedupeTtlSeconds,
      );
      if (!fresh) {
        this.logger.debug(`${source}:${naturalId} already applied — skipping`);
        return;
      }

      const deltas = buildDeltas().filter((d) => d.delta !== 0);
      if (deltas.length === 0) return;

      const scopes = attributionUserId
        ? await this.scopes.scopesFor(attributionUserId, roomId)
        : ['g', scopeRoom(roomId)];

      const increments: LeaderboardIncrement[] = [];
      const touched = new Set<string>();

      for (const scope of scopes) {
        const isRoomScoped = parseScope(scope)?.kind === 'room';
        for (const { dimension, member, delta } of deltas) {
          touched.add(`${scope}|${dimension}`);
          for (const period of VIDEO_ROOM_RANKING_HOT_PERIODS) {
            increments.push({
              key: this.store.key(
                this.ns,
                scope,
                dimension,
                period,
                this.periods.dateKeyFor(period, occurredAt),
              ),
              member,
              delta,
              // Room ladders expire so an ended room stops consuming memory.
              // Global/country/city ladders are snapshotted and TTL'd by the
              // aggregation job instead, never by a write.
              ...(isRoomScoped ? { ttlSeconds: this.config.roomLadderTtlSeconds } : {}),
            });
          }
        }
      }

      await this.store.incrementMany(increments);

      // Invalidate every cached page of every ladder this write moved.
      await Promise.all(
        [...touched].map((pair) => {
          const [scope, dimension] = pair.split('|');
          return this.store.bumpVersion(this.ns, scope, dimension);
        }),
      );

      await this.publishMovements(deltas, roomId, occurredAt);
    } catch (err) {
      // Deliberately swallowed — see the class doc's invariant 3.
      this.logger.error(
        `ranking write failed for ${source}:${naturalId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Announce movement per dimension. The socket listener coalesces these into
   * at most one broadcast per room per window, so publishing one event per
   * dimension here is safe even during a gift storm.
   */
  private async publishMovements(
    deltas: DimensionDelta[],
    roomId: string,
    occurredAt: Date,
  ): Promise<void> {
    const daily: RankingPeriodName = 'daily';
    const dateKey = this.periods.dateKeyFor(daily, occurredAt);
    const seen = new Set<VideoRoomRankingDimension>();

    for (const { dimension } of deltas) {
      if (seen.has(dimension)) continue;
      seen.add(dimension);

      const payload = {
        scope: scopeRoom(roomId),
        dimension,
        period: daily,
        dateKey,
        roomId,
        entries: [] as [],
      };

      switch (dimension) {
        case VideoRoomRankingDimension.HOSTS:
          await this.bus.publish(new HostRankingUpdatedEvent(payload));
          break;
        case VideoRoomRankingDimension.GIFTERS:
          await this.bus.publish(new GifterRankingUpdatedEvent(payload));
          break;
        case VideoRoomRankingDimension.ROOMS:
          await this.bus.publish(new RoomRankingUpdatedEvent(payload));
          break;
        case VideoRoomRankingDimension.PK:
          await this.bus.publish(new PKRankingUpdatedEvent(payload));
          break;
        case VideoRoomRankingDimension.TREASURE:
          await this.bus.publish(new TreasureRankingUpdatedEvent(payload));
          break;
        default:
          await this.bus.publish(new RankingUpdatedEvent(payload));
      }
    }
  }
}
```

- [ ] **Step 4: Run the test**

```bash
pnpm test -- src/modules/video-rooms/services/video-room-ranking.service.spec.ts
pnpm lint
```

Expected: PASS; lint exit 0.

- [ ] **Step 5: Report and stop.** **Do not commit.**

---

## Task 12: VideoRoomRankingActivityListener

**Files:**
- Create: `src/modules/video-rooms/listeners/video-room-ranking-activity.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-ranking-activity.listener.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomRankingService` (Task 11); `EVENT_BUS`; `GIFT_EVENTS`/`GiftSentEvent`/`GiftRefundedEvent` from `src/modules/gifts/events/gift.events`; `VIDEO_ROOM_PK_EVENTS`/`PkEndedEvent`; `VIDEO_ROOM_TREASURE_EVENTS`/`TreasureRewardDistributedEvent`; `VIDEO_ROOM_EVENTS`/`RoomClosedEvent`; `VideoRoomSeatStateService` (to answer "is the receiver seated?" — use its existing read method; if none is suitable, inject `VideoRoomPresenceService` and check participant membership).
- Produces: `class VideoRoomRankingActivityListener implements OnModuleInit`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/listeners/video-room-ranking-activity.listener.spec.ts`:

```ts
import { GIFT_EVENTS } from 'src/modules/gifts/events/gift.events';
import { VIDEO_ROOM_PK_EVENTS } from '../events/video-room-pk.events';
import { VIDEO_ROOM_TREASURE_EVENTS } from '../events/video-room-treasure.events';
import { VideoRoomRankingActivityListener } from './video-room-ranking-activity.listener';

describe('VideoRoomRankingActivityListener', () => {
  let handlers: Record<string, (e: unknown) => unknown>;
  let bus: { subscribe: jest.Mock };
  let rankings: {
    recordGift: jest.Mock;
    recordGiftRefund: jest.Mock;
    recordPkResult: jest.Mock;
    recordTreasureWin: jest.Mock;
    recordRoomActivity: jest.Mock;
  };
  let seats: { isSeated: jest.Mock };

  beforeEach(() => {
    handlers = {};
    bus = {
      subscribe: jest.fn((name: string, h: (e: unknown) => unknown) => {
        handlers[name] = h;
        return () => undefined;
      }),
    };
    rankings = {
      recordGift: jest.fn().mockResolvedValue(undefined),
      recordGiftRefund: jest.fn().mockResolvedValue(undefined),
      recordPkResult: jest.fn().mockResolvedValue(undefined),
      recordTreasureWin: jest.fn().mockResolvedValue(undefined),
      recordRoomActivity: jest.fn().mockResolvedValue(undefined),
    };
    seats = { isSeated: jest.fn().mockResolvedValue(true) };
    new VideoRoomRankingActivityListener(bus as never, rankings as never, seats as never).onModuleInit();
  });

  const giftEvent = (over = {}) => ({
    payload: {
      transactionId: 'txn-1',
      senderId: 's1',
      receiverId: 'r1',
      contextType: 'VIDEO_ROOM',
      contextId: 'room-1',
      totalCoinValue: 100,
      quantity: 1,
      createdAt: '2026-07-22T14:35:00.000Z',
      ...over,
    },
  });

  it('subscribes to every source event exactly once', () => {
    expect(Object.keys(handlers).sort()).toEqual(
      [
        GIFT_EVENTS.SENT,
        GIFT_EVENTS.REFUNDED,
        VIDEO_ROOM_PK_EVENTS.ENDED,
        VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED,
        'video_room.closed',
      ].sort(),
    );
  });

  describe('gift.sent', () => {
    it('records a VIDEO_ROOM gift', async () => {
      await handlers[GIFT_EVENTS.SENT](giftEvent());
      expect(rankings.recordGift).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: 'txn-1',
          roomId: 'room-1',
          senderId: 's1',
          receiverId: 'r1',
          totalCoinValue: 100,
          receiverIsSeated: true,
        }),
      );
    });

    it('ignores gifts from every other context', async () => {
      for (const contextType of ['AUDIO_ROOM', 'LIVE_STREAM', 'PRIVATE_CHAT']) {
        await handlers[GIFT_EVENTS.SENT](giftEvent({ contextType }));
      }
      expect(rankings.recordGift).not.toHaveBeenCalled();
    });

    it('marks the receiver unseated when the seat lookup says so', async () => {
      seats.isSeated.mockResolvedValue(false);
      await handlers[GIFT_EVENTS.SENT](giftEvent());
      expect(rankings.recordGift.mock.calls[0][0].receiverIsSeated).toBe(false);
    });

    it('treats an unavailable seat lookup as unseated rather than failing', async () => {
      seats.isSeated.mockRejectedValue(new Error('redis down'));
      await handlers[GIFT_EVENTS.SENT](giftEvent());
      expect(rankings.recordGift.mock.calls[0][0].receiverIsSeated).toBe(false);
    });

    it('swallows a downstream failure so the gift flow is unaffected', async () => {
      rankings.recordGift.mockRejectedValue(new Error('boom'));
      await expect(handlers[GIFT_EVENTS.SENT](giftEvent())).resolves.not.toThrow();
    });
  });

  describe('pk ended', () => {
    it('maps team outcomes to per-user win/loss', async () => {
      await handlers[VIDEO_ROOM_PK_EVENTS.ENDED]({
        payload: {
          battleId: 'b1',
          roomId: 'room-1',
          winningTeamId: 't1',
          isDraw: false,
          teams: [
            { teamId: 't1', side: 'RED', score: 900 },
            { teamId: 't2', side: 'BLUE', score: 400 },
          ],
          participants: [
            { userId: 'w', side: 'RED', teamId: 't1' },
            { userId: 'l', side: 'BLUE', teamId: 't2' },
          ],
          durationSeconds: 300,
          giftCount: 10,
          totalBase: 1300,
        },
      });
      const outcomes = rankings.recordPkResult.mock.calls[0][0].outcomes;
      expect(outcomes).toEqual([
        { userId: 'w', won: true, lost: false, score: 900 },
        { userId: 'l', won: false, lost: true, score: 400 },
      ]);
    });

    it('records a draw as neither win nor loss', async () => {
      await handlers[VIDEO_ROOM_PK_EVENTS.ENDED]({
        payload: {
          battleId: 'b2',
          roomId: 'room-1',
          winningTeamId: null,
          isDraw: true,
          teams: [{ teamId: 't1', side: 'RED', score: 500 }],
          participants: [{ userId: 'a', side: 'RED', teamId: 't1' }],
          durationSeconds: 300,
          giftCount: 5,
          totalBase: 1000,
        },
      });
      expect(rankings.recordPkResult.mock.calls[0][0].outcomes[0]).toEqual({
        userId: 'a',
        won: false,
        lost: false,
        score: 500,
      });
    });
  });

  describe('treasure reward distributed', () => {
    it('records one win per recipient', async () => {
      await handlers[VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED]({
        payload: {
          correlationId: 'c1',
          roomId: 'room-1',
          sessionId: 's1',
          boxId: 'b1',
          winners: [
            { userId: 'u1', amount: 100, shareBps: 5000 },
            { userId: 'u2', amount: 100, shareBps: 5000 },
          ],
        },
      });
      expect(rankings.recordTreasureWin).toHaveBeenCalledTimes(2);
      // Reward id must be unique per winner, or the second is deduped away.
      const ids = rankings.recordTreasureWin.mock.calls.map((c) => c[0].rewardId);
      expect(new Set(ids).size).toBe(2);
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm test -- src/modules/video-rooms/listeners/video-room-ranking-activity.listener.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Confirm the seat-occupancy read method before implementing**

```bash
grep -n "async isSeated\|async occupantOf\|async seatOf\|getState" src/modules/video-rooms/services/video-room-seat-state.service.ts | head
```

Use whichever existing method answers "does this user hold a seat in this room". If none exists, add a thin `isSeated(roomId, userId): Promise<boolean>` to `VideoRoomSeatStateService` that reads the existing seat snapshot — do **not** add a new Redis key.

- [ ] **Step 4: Implement the listener**

Create `src/modules/video-rooms/listeners/video-room-ranking-activity.listener.ts`:

```ts
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  GIFT_EVENTS,
  type GiftRefundedEvent,
  type GiftSentEvent,
} from 'src/modules/gifts/events/gift.events';
import { VIDEO_ROOM_EVENTS, type RoomClosedEvent } from '../events/video-room.events';
import { VIDEO_ROOM_PK_EVENTS, type PkEndedEvent } from '../events/video-room-pk.events';
import {
  VIDEO_ROOM_TREASURE_EVENTS,
  type TreasureRewardDistributedEvent,
} from '../events/video-room-treasure.events';
import { VideoRoomSeatStateService } from '../services/video-room-seat-state.service';
import { VideoRoomRankingService } from '../services/video-room-ranking.service';

/**
 * The VR-13 write trigger: every source event that should move a ladder.
 *
 * This listener is ADDITIVE to the platform `RankingsActivityListener`, which
 * also consumes `gift.sent`. The two never collide because they write different
 * namespaces — `rankings:*` there, `vrank:*` here (see
 * VideoRoomRankingService). Removing either would silently drop a whole family
 * of ladders.
 *
 * Every handler swallows. These events announce money that has already moved;
 * throwing back into the bus would only break the OTHER subscribers —
 * notifications, EXP, the socket bridges — for a ranking that the recompute
 * pass will restore anyway.
 */
@Injectable()
export class VideoRoomRankingActivityListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomRankingActivityListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly rankings: VideoRoomRankingService,
    private readonly seats: VideoRoomSeatStateService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<GiftSentEvent>(GIFT_EVENTS.SENT, (e) => this.onGiftSent(e));
    this.bus.subscribe<GiftRefundedEvent>(GIFT_EVENTS.REFUNDED, (e) => this.onGiftRefunded(e));
    this.bus.subscribe<PkEndedEvent>(VIDEO_ROOM_PK_EVENTS.ENDED, (e) => this.onPkEnded(e));
    this.bus.subscribe<TreasureRewardDistributedEvent>(
      VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED,
      (e) => this.onTreasureDistributed(e),
    );
    this.bus.subscribe<RoomClosedEvent>(VIDEO_ROOM_EVENTS.CLOSED, (e) => this.onRoomClosed(e));
  }

  private async onGiftSent(event: GiftSentEvent): Promise<void> {
    const p = event.payload;
    // The gifts module publishes for every context; only video rooms are ours.
    if (p.contextType !== 'VIDEO_ROOM') return;
    try {
      await this.rankings.recordGift({
        transactionId: p.transactionId,
        roomId: p.contextId,
        senderId: p.senderId,
        receiverId: p.receiverId,
        totalCoinValue: p.totalCoinValue,
        quantity: p.quantity,
        receiverIsSeated: await this.isSeated(p.contextId, p.receiverId),
        occurredAt: new Date(p.createdAt),
      });
    } catch (err) {
      this.logger.error(`ranking gift.sent failed (${p.transactionId}): ${(err as Error).message}`);
    }
  }

  /**
   * An unavailable seat lookup resolves to `false`, not a throw. Crediting the
   * hosts ladder on a guess would be worse than briefly under-crediting it —
   * the recompute pass recovers the correct value from source rows.
   */
  private async isSeated(roomId: string, userId: string): Promise<boolean> {
    try {
      return await this.seats.isSeated(roomId, userId);
    } catch (err) {
      this.logger.warn(`seat lookup failed for ${userId} in ${roomId}: ${(err as Error).message}`);
      return false;
    }
  }

  private async onGiftRefunded(event: GiftRefundedEvent): Promise<void> {
    const p = event.payload;
    try {
      await this.rankings.recordGiftRefund({
        transactionId: p.transactionId,
        roomId: p.roomId,
        senderId: p.senderId,
        // A refund reverses the sender's spend; the receiver leg is reversed by
        // the same transaction id under the gift-refund marker.
        receiverId: p.senderId,
        totalCoinValue: p.totalRefundAmount,
        quantity: 1,
        receiverIsSeated: false,
        occurredAt: new Date(p.createdAt),
      });
    } catch (err) {
      this.logger.error(`ranking gift.refunded failed: ${(err as Error).message}`);
    }
  }

  private async onPkEnded(event: PkEndedEvent): Promise<void> {
    const p = event.payload;
    try {
      const scoreByTeam = new Map(p.teams.map((t) => [t.teamId, t.score]));
      await this.rankings.recordPkResult({
        battleId: p.battleId,
        roomId: p.roomId,
        occurredAt: new Date(event.occurredAt),
        outcomes: (p.participants ?? []).map((participant) => ({
          userId: participant.userId,
          // A draw is neither: winningTeamId is null, so both stay false.
          won: !p.isDraw && p.winningTeamId === participant.teamId,
          lost: !p.isDraw && p.winningTeamId !== null && p.winningTeamId !== participant.teamId,
          score: scoreByTeam.get(participant.teamId) ?? 0,
        })),
      });
    } catch (err) {
      this.logger.error(`ranking pk.ended failed (${p.battleId}): ${(err as Error).message}`);
    }
  }

  private async onTreasureDistributed(event: TreasureRewardDistributedEvent): Promise<void> {
    const p = event.payload as unknown as {
      roomId: string;
      boxId?: string;
      correlationId: string;
      winners?: { userId: string; amount: number }[];
    };
    try {
      for (const winner of p.winners ?? []) {
        await this.rankings.recordTreasureWin({
          // Per-winner id: a shared id would dedupe every winner but the first.
          rewardId: `${p.boxId ?? p.correlationId}:${winner.userId}`,
          roomId: p.roomId,
          userId: winner.userId,
          amount: winner.amount,
          occurredAt: new Date(event.occurredAt),
        });
      }
    } catch (err) {
      this.logger.error(`ranking treasure distribution failed: ${(err as Error).message}`);
    }
  }

  private async onRoomClosed(event: RoomClosedEvent): Promise<void> {
    const p = event.payload as unknown as { roomId: string; sessionId?: string };
    try {
      await this.rankings.recordRoomActivity({
        activityId: `close:${p.sessionId ?? p.roomId}:${event.eventId}`,
        roomId: p.roomId,
        occurredAt: new Date(event.occurredAt),
      });
    } catch (err) {
      this.logger.error(`ranking room.closed failed: ${(err as Error).message}`);
    }
  }
}
```

Note for the implementer: `PkEndedEvent`'s payload does not currently declare `participants`. Confirm against `events/video-room-pk.events.ts` — if absent, either read participants via `VideoRoomPkQueryService` inside the handler, or add `participants` to the `PkEndedEvent` payload (it is already on `PkStartedEvent`). **Prefer reading via the query service** — widening a shipped event's payload is a larger change than this task should make.

- [ ] **Step 5: Run the test and lint**

```bash
pnpm test -- src/modules/video-rooms/listeners/video-room-ranking-activity.listener.spec.ts
pnpm lint
```

Expected: PASS; lint exit 0.

- [ ] **Step 6: Report and stop.** Flag the `PkEndedEvent.participants` resolution you chose. **Do not commit.**

---

## Task 13: VideoRoomRankingAggregationService — the recompute path

**Files:**
- Create: `src/modules/video-rooms/services/video-room-ranking-aggregation.service.ts`
- Test: `src/modules/video-rooms/services/video-room-ranking-aggregation.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomRankingRepository` (Task 9), `LeaderboardStore` (Task 2), `RankingPeriodResolver` (Task 1), `VideoRoomRankingScoreEngine` (Task 7), `VideoRoomRankingScopeResolver` (Task 8), config/constants (Task 6), `RankingAggregatedEvent` (Task 10), `EVENT_BUS`.
- Produces `class VideoRoomRankingAggregationService` with:
  - `recomputeDimension(dimension, period, dateKey): Promise<AggregationResult>`
  - `recomputeAll(period, dateKey): Promise<AggregationResult[]>`
  - `derivePeriod(dimension, period, dateKey): Promise<number>`
  - `interface AggregationResult { key: RankingLadderKey; status: 'RECOMPUTED' | 'SKIPPED' | 'FAILED'; entriesWritten: number; sourceRows: number; durationMs: number }`

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/services/video-room-ranking-aggregation.service.spec.ts`:

```ts
import { RankingPeriodResolver } from 'src/modules/rankings/services/ranking-period.resolver';
import { VideoRoomRankingDimension } from '../constants/video-room-ranking.constants';
import { VideoRoomRankingAggregationService } from './video-room-ranking-aggregation.service';
import { VideoRoomRankingScoreEngine } from './video-room-ranking-score.engine';

describe('VideoRoomRankingAggregationService', () => {
  const config = { get: () => ({}) } as never;
  let repo: any;
  let store: any;
  let scopes: { geoForMany: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomRankingAggregationService;

  beforeEach(() => {
    repo = {
      beginAggregation: jest.fn().mockResolvedValue('CLAIMED'),
      completeAggregation: jest.fn().mockResolvedValue(undefined),
      failAggregation: jest.fn().mockResolvedValue(undefined),
      aggregateGiftCoinsBySender: jest
        .fn()
        .mockResolvedValue([{ userId: 'u1', coins: 500n, gifts: 3 }]),
      aggregateGiftCoinsByReceiver: jest.fn().mockResolvedValue([]),
      aggregateGiftCoinsByRoom: jest.fn().mockResolvedValue([]),
      aggregatePkOutcomes: jest.fn().mockResolvedValue([]),
      aggregateTreasureWinnings: jest.fn().mockResolvedValue([]),
      findRoomStatistics: jest.fn().mockResolvedValue([]),
    };
    store = {
      key: jest.fn((ns, s, d, p, k) => `${ns}:{${s}|${d}}:${p}:${k}`),
      replace: jest.fn().mockResolvedValue(undefined),
      derive: jest.fn().mockResolvedValue(4),
      bumpVersion: jest.fn().mockResolvedValue(2),
    };
    scopes = {
      geoForMany: jest
        .fn()
        .mockResolvedValue(new Map([['u1', { country: 'IN', city: 'c9' }]])),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };

    service = new VideoRoomRankingAggregationService(
      config,
      repo,
      store,
      new RankingPeriodResolver(),
      new VideoRoomRankingScoreEngine(config),
      scopes as never,
      bus as never,
    );
  });

  describe('recomputeDimension', () => {
    it('claims the window before doing any work', async () => {
      await service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260722');
      expect(repo.beginAggregation).toHaveBeenCalledWith(
        { scope: 'g', dimension: 'gifters', period: 'daily', dateKey: '20260722' },
        new Date('2026-07-22T00:00:00.000Z'),
        new Date('2026-07-23T00:00:00.000Z'),
      );
    });

    it('skips entirely when the window already succeeded', async () => {
      repo.beginAggregation.mockResolvedValue('ALREADY_SUCCEEDED');
      const result = await service.recomputeDimension(
        VideoRoomRankingDimension.GIFTERS,
        'daily',
        '20260722',
      );
      expect(result.status).toBe('SKIPPED');
      expect(repo.aggregateGiftCoinsBySender).not.toHaveBeenCalled();
      expect(store.replace).not.toHaveBeenCalled();
    });

    it('replaces the ladder atomically rather than incrementing it', async () => {
      await service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260722');
      expect(store.replace).toHaveBeenCalled();
      const [key, entries] = store.replace.mock.calls[0];
      expect(key).toBe('vrank:{g|gifters}:daily:20260722');
      expect(entries).toEqual([{ member: 'u1', score: 500 }]);
    });

    it('rebuilds the country and city ladders from the same source rows', async () => {
      await service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260722');
      const keys = store.replace.mock.calls.map((c: unknown[]) => c[0]);
      expect(keys).toContain('vrank:{c:IN|gifters}:daily:20260722');
      expect(keys).toContain('vrank:{y:c9|gifters}:daily:20260722');
    });

    it('produces the same score the incremental path would have', async () => {
      // gifters is a pass-through dimension: 500 coins spent → score 500.
      await service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260722');
      expect(store.replace.mock.calls[0][1][0].score).toBe(500);
    });

    it('marks the window succeeded with its stats', async () => {
      const result = await service.recomputeDimension(
        VideoRoomRankingDimension.GIFTERS,
        'daily',
        '20260722',
      );
      expect(result.status).toBe('RECOMPUTED');
      expect(repo.completeAggregation).toHaveBeenCalledWith(
        expect.objectContaining({ dimension: 'gifters' }),
        expect.objectContaining({ entriesWritten: 1, sourceRows: 1 }),
      );
    });

    it('bumps the ladder version so cached pages invalidate', async () => {
      await service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260722');
      expect(store.bumpVersion).toHaveBeenCalled();
    });

    it('publishes an aggregated event', async () => {
      await service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260722');
      expect(bus.publish).toHaveBeenCalled();
    });

    it('records the failure and rethrows so BullMQ can retry', async () => {
      repo.aggregateGiftCoinsBySender.mockRejectedValue(new Error('db down'));
      await expect(
        service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260722'),
      ).rejects.toThrow('db down');
      expect(repo.failAggregation).toHaveBeenCalled();
    });

    it('rejects an invalid dateKey before touching the database', async () => {
      await expect(
        service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260732'),
      ).rejects.toThrow();
      expect(repo.beginAggregation).not.toHaveBeenCalled();
    });

    it('clears a ladder whose window turned out to be empty', async () => {
      repo.aggregateGiftCoinsBySender.mockResolvedValue([]);
      await service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260722');
      expect(store.replace).toHaveBeenCalledWith(expect.any(String), [], expect.any(Number));
    });
  });

  describe('derivePeriod', () => {
    it('unions a quarter from its three monthly keys', async () => {
      await service.derivePeriod(VideoRoomRankingDimension.HOSTS, 'quarterly', '2026Q3');
      expect(store.derive).toHaveBeenCalledWith(
        'vrank:{g|hosts}:quarterly:2026Q3',
        [
          'vrank:{g|hosts}:monthly:202607',
          'vrank:{g|hosts}:monthly:202608',
          'vrank:{g|hosts}:monthly:202609',
        ],
        expect.any(Number),
      );
    });

    it('refuses to derive a hot period, which is materialised not derived', async () => {
      await expect(
        service.derivePeriod(VideoRoomRankingDimension.HOSTS, 'daily', '20260722'),
      ).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm test -- src/modules/video-rooms/services/video-room-ranking-aggregation.service.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the aggregation service**

Create `src/modules/video-rooms/services/video-room-ranking-aggregation.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import type { RankedEntry } from 'src/modules/rankings/services/leaderboard-store.service';
import { LeaderboardStore } from 'src/modules/rankings/services/leaderboard-store.service';
import {
  RankingPeriodResolver,
  type RankingPeriodName,
} from 'src/modules/rankings/services/ranking-period.resolver';
import {
  loadVideoRoomRankingConfig,
  type VideoRoomRankingConfig,
} from '../config/video-room-ranking.config';
import {
  VideoRoomRankingDimension,
  VIDEO_ROOM_RANKING_DERIVED_PERIODS,
  VIDEO_ROOM_RANKING_NAMESPACE,
  scopeCity,
  scopeCountry,
  scopeGlobal,
} from '../constants/video-room-ranking.constants';
import { AggregationException, RankingPeriodException } from '../exceptions/video-room-ranking.exceptions';
import { RankingAggregatedEvent } from '../events/video-room-ranking.events';
import type {
  AggregationWindow,
  RankingLadderKey,
} from '../repositories/video-room-ranking.repository';
import { VideoRoomRankingRepository } from '../repositories/video-room-ranking.repository';
import { VideoRoomRankingScopeResolver } from './video-room-ranking-scope.resolver';
import { VideoRoomRankingScoreEngine } from './video-room-ranking-score.engine';

export interface AggregationResult {
  key: RankingLadderKey;
  status: 'RECOMPUTED' | 'SKIPPED' | 'FAILED';
  entriesWritten: number;
  sourceRows: number;
  durationMs: number;
}

/** One entity's recomputed standing, before scope partitioning. */
interface SourceRow {
  member: string;
  score: number;
  /** Absent for room-dimension rows — rooms are not partitioned by user geo. */
  userId?: string;
}

/**
 * The authoritative half of the lambda model.
 *
 * Where the write path ACCUMULATES deltas, this RECOUNTS a closed window from
 * the source tables and swaps the result in. That is what makes the whole
 * design tolerant of the write path's known gaps — a crash between the dedupe
 * marker and the fan-out, an evicted marker, a Redis flush, a listener that was
 * down during a deploy. None of them survive the next run of this service.
 *
 * The correctness hinge is that it scores through the SAME
 * VideoRoomRankingScoreEngine the write path uses. A second implementation of
 * the weighting here would reintroduce exactly the drift this exists to remove.
 */
@Injectable()
export class VideoRoomRankingAggregationService {
  private readonly logger = new Logger(VideoRoomRankingAggregationService.name);
  private readonly config: VideoRoomRankingConfig;
  private readonly ns = VIDEO_ROOM_RANKING_NAMESPACE;

  constructor(
    config: ConfigService,
    private readonly repo: VideoRoomRankingRepository,
    private readonly store: LeaderboardStore,
    private readonly periods: RankingPeriodResolver,
    private readonly scoring: VideoRoomRankingScoreEngine,
    private readonly scopes: VideoRoomRankingScopeResolver,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {
    this.config = loadVideoRoomRankingConfig(config);
  }

  /** Recompute every dimension for one window. */
  async recomputeAll(period: RankingPeriodName, dateKey: string): Promise<AggregationResult[]> {
    const results: AggregationResult[] = [];
    for (const dimension of Object.values(VideoRoomRankingDimension)) {
      try {
        results.push(await this.recomputeDimension(dimension, period, dateKey));
      } catch (err) {
        // One dimension's failure must not abandon the rest of the window.
        this.logger.error(
          `recompute ${dimension}:${period}:${dateKey} failed: ${(err as Error).message}`,
        );
        results.push({
          key: { scope: scopeGlobal(), dimension, period, dateKey },
          status: 'FAILED',
          entriesWritten: 0,
          sourceRows: 0,
          durationMs: 0,
        });
      }
    }
    return results;
  }

  async recomputeDimension(
    dimension: VideoRoomRankingDimension,
    period: RankingPeriodName,
    dateKey: string,
  ): Promise<AggregationResult> {
    if (!this.periods.isValidDateKey(period, dateKey)) {
      throw new RankingPeriodException(`"${dateKey}" is not a valid ${period} date key`);
    }

    const key: RankingLadderKey = { scope: scopeGlobal(), dimension, period, dateKey };
    const window = this.periods.windowFor(period, dateKey);
    const startedAt = Date.now();

    const claim = await this.repo.beginAggregation(key, window.start, window.end);
    if (claim === 'ALREADY_SUCCEEDED') {
      this.logger.debug(`${dimension}:${period}:${dateKey} already aggregated — skipping`);
      return { key, status: 'SKIPPED', entriesWritten: 0, sourceRows: 0, durationMs: 0 };
    }

    try {
      const rows = await this.loadSourceRows(dimension, window);
      const written = await this.writeScopedLadders(dimension, period, dateKey, rows);
      const durationMs = Date.now() - startedAt;

      await this.repo.completeAggregation(key, {
        sourceRows: rows.length,
        entriesWritten: written,
        durationMs,
      });

      await this.bus.publish(
        new RankingAggregatedEvent({
          scope: key.scope,
          dimension,
          period,
          dateKey,
          entriesWritten: written,
          sourceRows: rows.length,
          durationMs,
        }),
      );

      return {
        key,
        status: 'RECOMPUTED',
        entriesWritten: written,
        sourceRows: rows.length,
        durationMs,
      };
    } catch (err) {
      await this.repo.failAggregation(key, (err as Error).message);
      // Rethrown on purpose: this is a genuine failure, and BullMQ's retry then
      // dead-letter path is the correct handling. Swallowing would leave a
      // silently wrong ladder with a FAILED log row nobody reads.
      throw err;
    }
  }

  /** Recount a window from the source tables, scored through the shared engine. */
  private async loadSourceRows(
    dimension: VideoRoomRankingDimension,
    window: AggregationWindow,
  ): Promise<SourceRow[]> {
    switch (dimension) {
      case VideoRoomRankingDimension.GIFTERS: {
        const rows = await this.repo.aggregateGiftCoinsBySender(window);
        return rows.map((r) => ({
          member: r.userId,
          userId: r.userId,
          score: this.scoring.composite(dimension, { coinsSpent: Number(r.coins) }),
        }));
      }
      case VideoRoomRankingDimension.RECEIVERS: {
        const rows = await this.repo.aggregateGiftCoinsByReceiver(window);
        return rows.map((r) => ({
          member: r.userId,
          userId: r.userId,
          score: this.scoring.composite(dimension, { coinsReceived: Number(r.coins) }),
        }));
      }
      case VideoRoomRankingDimension.HOSTS: {
        const rows = await this.repo.aggregateGiftCoinsByReceiver(window);
        return rows.map((r) => ({
          member: r.userId,
          userId: r.userId,
          score: this.scoring.composite(dimension, {
            coins: Number(r.coins),
            gifts: r.gifts,
          }),
        }));
      }
      case VideoRoomRankingDimension.ROOMS: {
        const rows = await this.repo.aggregateGiftCoinsByRoom(window);
        const stats = await this.repo.findRoomStatistics(rows.map((r) => r.roomId));
        const byRoom = new Map(stats.map((s) => [s.roomId, s]));
        return rows.map((r) => {
          const stat = byRoom.get(r.roomId);
          return {
            member: r.roomId,
            score: this.scoring.composite(dimension, {
              giftCoins: Number(r.coins),
              peakViewers: stat?.peakViewers ?? 0,
              avgWatchSeconds: stat?.avgWatchTimeSeconds ?? 0,
              pkCount: stat?.totalPkCount ?? 0,
            }),
          };
        });
      }
      case VideoRoomRankingDimension.PK: {
        const rows = await this.repo.aggregatePkOutcomes(window);
        return rows.map((r) => ({
          member: r.userId,
          userId: r.userId,
          score: this.scoring.composite(dimension, {
            wins: r.wins,
            losses: r.losses,
            score: Number(r.score),
            giftCoins: Number(r.giftCoins),
          }),
        }));
      }
      case VideoRoomRankingDimension.TREASURE: {
        const rows = await this.repo.aggregateTreasureWinnings(window);
        return rows.map((r) => ({
          member: r.userId,
          userId: r.userId,
          score: this.scoring.composite(dimension, { treasureCoins: Number(r.coins) }),
        }));
      }
      case VideoRoomRankingDimension.VIP:
        // VIP standing is a property of the account, not of a time window —
        // there is nothing in gift/PK/treasure history to recount it from. It
        // is maintained solely by the incremental path.
        return [];
    }
  }

  /**
   * Partition the recomputed rows into global, country and city ladders and
   * swap each in. Geography is re-resolved here rather than trusted from write
   * time, which is what lets a country ladder heal even if the cached geo was
   * wrong or missing when the original gift landed.
   */
  private async writeScopedLadders(
    dimension: VideoRoomRankingDimension,
    period: RankingPeriodName,
    dateKey: string,
    rows: SourceRow[],
  ): Promise<number> {
    const ttl = this.config.derivedLadderTtlSeconds;
    const byScope = new Map<string, RankedEntry[]>();
    byScope.set(
      scopeGlobal(),
      rows.map((r) => ({ member: r.member, score: r.score })),
    );

    const userIds = rows.map((r) => r.userId).filter((id): id is string => Boolean(id));
    if (userIds.length > 0) {
      const geo = await this.scopes.geoForMany(userIds);
      for (const row of rows) {
        if (!row.userId) continue;
        const g = geo.get(row.userId);
        const entry: RankedEntry = { member: row.member, score: row.score };
        if (g?.country) {
          const s = scopeCountry(g.country);
          byScope.set(s, [...(byScope.get(s) ?? []), entry]);
        }
        if (g?.city) {
          const s = scopeCity(g.city);
          byScope.set(s, [...(byScope.get(s) ?? []), entry]);
        }
      }
    }

    let written = 0;
    for (const [scope, entries] of byScope) {
      await this.store.replace(
        this.store.key(this.ns, scope, dimension, period, dateKey),
        entries,
        ttl,
      );
      // Every cached page of this ladder is now stale.
      await this.store.bumpVersion(this.ns, scope, dimension);
      written += entries.length;
    }
    return written;
  }

  /**
   * Materialise a derived period by unioning its hot constituents. Quarterly and
   * yearly are never incremented, so this is the only way they come to exist.
   */
  async derivePeriod(
    dimension: VideoRoomRankingDimension,
    period: RankingPeriodName,
    dateKey: string,
  ): Promise<number> {
    if (!VIDEO_ROOM_RANKING_DERIVED_PERIODS.includes(period)) {
      throw new AggregationException(
        `"${period}" is materialised on the write path and must not be derived`,
      );
    }
    const parts = this.periods.constituentsOf(period, dateKey);
    const dest = this.store.key(this.ns, scopeGlobal(), dimension, period, dateKey);
    const sources = parts.map((p) =>
      this.store.key(this.ns, scopeGlobal(), dimension, p.period, p.dateKey),
    );
    const count = await this.store.derive(dest, sources, this.config.derivedLadderTtlSeconds);
    await this.store.bumpVersion(this.ns, scopeGlobal(), dimension);
    return count;
  }
}
```

- [ ] **Step 4: Run the test and lint**

```bash
pnpm test -- src/modules/video-rooms/services/video-room-ranking-aggregation.service.spec.ts
pnpm lint
```

Expected: PASS; lint exit 0.

- [ ] **Step 5: Run the whole VR-13 suite so far**

```bash
pnpm test -- src/modules/rankings src/modules/video-rooms/services/video-room-ranking src/modules/video-rooms/repositories/video-room-ranking src/modules/video-rooms/listeners/video-room-ranking src/modules/video-rooms/constants/video-room-ranking src/modules/video-rooms/config/video-room-ranking src/modules/video-rooms/exceptions/video-room-ranking src/modules/video-rooms/events/video-room-ranking
```

Expected: all PASS.

- [ ] **Step 6: Report and stop.** **Do not commit.**

---

## Next

Tasks 14–19 continue in `docs/superpowers/plans/2026-07-22-vr13-ranking-engine-part3.md`:

| Task | Deliverable |
|---|---|
| 14 | `VideoRoomRankingSnapshotService` + `VideoRoomRankingRecoveryService` |
| 15 | `VideoRoomRankingJobsService` + `VideoRoomRankingScheduler` |
| 16 | `VideoRoomRankingQueryService` + `VideoRoomLeaderboardService` |
| 17 | DTOs + `VideoRoomsRankingsController` (11 routes, full Swagger) |
| 18 | Socket + metrics + audit listeners; `VideoRoomsMetrics` additions |
| 19 | Module wiring + `video-rooms-ranking.integration.spec.ts` |
