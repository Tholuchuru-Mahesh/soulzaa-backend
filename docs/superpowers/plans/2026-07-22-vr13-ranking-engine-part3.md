# VR-13 Ranking Engine — Implementation Plan, Part 3 (Tasks 14–19)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **Read Parts 1 and 2 first:** `2026-07-22-vr13-ranking-engine.md` and `...-part2.md`. Part 1's **Global Constraints** apply to every task here — in particular: **never run `git commit` or `git push`**, never write `rankings:*` keys, and never put Prisma inside a service.

**Covers:** snapshots and recovery, background jobs, the read path, the REST surface, the observability listeners, and final wiring plus an integration test.

---

## Task 14: SnapshotService + RecoveryService

**Files:**
- Create: `src/modules/video-rooms/services/video-room-ranking-snapshot.service.ts`
- Test: `src/modules/video-rooms/services/video-room-ranking-snapshot.service.spec.ts`
- Create: `src/modules/video-rooms/services/video-room-ranking-recovery.service.ts`
- Test: `src/modules/video-rooms/services/video-room-ranking-recovery.service.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomRankingRepository`, `LeaderboardStore`, `RankingPeriodResolver`, `VideoRoomRankingAggregationService`, config/constants, `RankingSnapshotCreatedEvent`, `EVENT_BUS`.
- Produces:
  - `class VideoRoomRankingSnapshotService` with `snapshotLadder(scope, dimension, period, dateKey): Promise<number>`, `snapshotAll(period, dateKey): Promise<number>`, `pruneExpired(): Promise<Record<string, number>>`
  - `class VideoRoomRankingRecoveryService` with `replay(period, dateKey): Promise<AggregationResult[]>`, `rebuildFromSnapshot(scope, dimension, period, dateKey): Promise<number>`

- [ ] **Step 1: Write the failing snapshot test**

Create `src/modules/video-rooms/services/video-room-ranking-snapshot.service.spec.ts`:

```ts
import { RankingPeriodResolver } from 'src/modules/rankings/services/ranking-period.resolver';
import { VideoRoomRankingDimension } from '../constants/video-room-ranking.constants';
import { VideoRoomRankingSnapshotService } from './video-room-ranking-snapshot.service';

describe('VideoRoomRankingSnapshotService', () => {
  const config = { get: () => ({}) } as never;
  let repo: any;
  let store: any;
  let bus: { publish: jest.Mock };
  let service: VideoRoomRankingSnapshotService;

  beforeEach(() => {
    repo = {
      saveRankingSnapshots: jest.fn().mockResolvedValue(2),
      upsertLeaderboardSnapshot: jest.fn().mockResolvedValue(undefined),
      pruneSnapshots: jest.fn().mockResolvedValue(7),
    };
    store = {
      key: jest.fn((ns, s, d, p, k) => `${ns}:{${s}|${d}}:${p}:${k}`),
      top: jest.fn().mockResolvedValue([
        { member: 'u1', score: 900 },
        { member: 'u2', score: 400 },
      ]),
      count: jest.fn().mockResolvedValue(57),
      expire: jest.fn().mockResolvedValue(1),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new VideoRoomRankingSnapshotService(
      config,
      repo,
      store,
      new RankingPeriodResolver(),
      bus as never,
    );
  });

  describe('snapshotLadder', () => {
    it('persists one ranked row per entry with a 1-based rank', async () => {
      await service.snapshotLadder('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722');
      const rows = repo.saveRankingSnapshots.mock.calls[0][0];
      expect(rows).toEqual([
        expect.objectContaining({ targetId: 'u1', rank: 1, score: 900n }),
        expect.objectContaining({ targetId: 'u2', rank: 2, score: 400n }),
      ]);
    });

    it('stores the score as BigInt — coin totals can exceed 2^53', async () => {
      await service.snapshotLadder('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722');
      expect(typeof repo.saveRankingSnapshots.mock.calls[0][0][0].score).toBe('bigint');
    });

    it('also writes the materialised top-N row with the FULL ladder size', async () => {
      await service.snapshotLadder('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722');
      expect(repo.upsertLeaderboardSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'g', dimension: 'hosts', totalEntries: 57 }),
      );
    });

    it('serialises entry scores as strings so the JSON column is valid', async () => {
      await service.snapshotLadder('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722');
      const { entries } = repo.upsertLeaderboardSnapshot.mock.calls[0][0];
      expect(() => JSON.stringify(entries)).not.toThrow();
      expect(entries[0]).toEqual({ targetId: 'u1', rank: 1, score: '900' });
    });

    it('TTLs the Redis ladder once it is durably persisted', async () => {
      await service.snapshotLadder('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722');
      expect(store.expire).toHaveBeenCalledWith(
        'vrank:{g|hosts}:daily:20260722',
        expect.any(Number),
      );
    });

    it('writes nothing and does not TTL when the ladder is empty', async () => {
      store.top.mockResolvedValue([]);
      await expect(
        service.snapshotLadder('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722'),
      ).resolves.toBe(0);
      expect(repo.saveRankingSnapshots).not.toHaveBeenCalled();
      expect(store.expire).not.toHaveBeenCalled();
    });

    it('publishes a snapshot-created event', async () => {
      await service.snapshotLadder('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722');
      expect(bus.publish).toHaveBeenCalled();
    });

    it('rejects an invalid dateKey before reading Redis', async () => {
      await expect(
        service.snapshotLadder('g', VideoRoomRankingDimension.HOSTS, 'daily', 'nope'),
      ).rejects.toThrow();
      expect(store.top).not.toHaveBeenCalled();
    });
  });

  describe('pruneExpired', () => {
    it('prunes each retained period at its own cutoff', async () => {
      const counts = await service.pruneExpired();
      expect(repo.pruneSnapshots).toHaveBeenCalledWith('hourly', expect.any(Date));
      expect(repo.pruneSnapshots).toHaveBeenCalledWith('daily', expect.any(Date));
      expect(repo.pruneSnapshots).toHaveBeenCalledWith('weekly', expect.any(Date));
      expect(counts).toEqual({ hourly: 7, daily: 7, weekly: 7 });
    });

    it('never prunes monthly, quarterly or yearly — those are retained forever', async () => {
      await service.pruneExpired();
      const periods = repo.pruneSnapshots.mock.calls.map((c: string[]) => c[0]);
      expect(periods).not.toContain('monthly');
      expect(periods).not.toContain('yearly');
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm test -- src/modules/video-rooms/services/video-room-ranking-snapshot.service.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the snapshot service**

Create `src/modules/video-rooms/services/video-room-ranking-snapshot.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
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
  VIDEO_ROOM_RANKING_NAMESPACE,
  VIDEO_ROOM_RANKING_SNAPSHOT_SIZE,
  scopeGlobal,
} from '../constants/video-room-ranking.constants';
import { RankingSnapshotCreatedEvent } from '../events/video-room-ranking.events';
import { RankingPeriodException } from '../exceptions/video-room-ranking.exceptions';
import { VideoRoomRankingRepository } from '../repositories/video-room-ranking.repository';

/** Snapshot TTL applied to a Redis ladder once it is durably persisted. */
const POST_SNAPSHOT_TTL_SECONDS = 30 * 24 * 3600;

/**
 * Freezes a closed ladder into PostgreSQL.
 *
 * Two rows are written per ladder, deliberately. `VideoRoomRankingSnapshot`
 * holds one row per entity, which is what makes "show me my rank every day
 * this month" a single indexed query. `VideoRoomLeaderboardSnapshot` holds the
 * whole top-N as one JSON row, which is what makes "show me last month's
 * leaderboard" one read instead of a hundred. Neither shape answers the other's
 * question efficiently, and the duplication is bounded and append-only.
 *
 * Once persisted, the Redis ladder gets a TTL: the durable copy is now the
 * system of record for that window, so holding it in memory forever would grow
 * without bound for no read benefit.
 */
@Injectable()
export class VideoRoomRankingSnapshotService {
  private readonly logger = new Logger(VideoRoomRankingSnapshotService.name);
  private readonly config: VideoRoomRankingConfig;
  private readonly ns = VIDEO_ROOM_RANKING_NAMESPACE;

  constructor(
    config: ConfigService,
    private readonly repo: VideoRoomRankingRepository,
    private readonly store: LeaderboardStore,
    private readonly periods: RankingPeriodResolver,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {
    this.config = loadVideoRoomRankingConfig(config);
  }

  async snapshotLadder(
    scope: string,
    dimension: VideoRoomRankingDimension,
    period: RankingPeriodName,
    dateKey: string,
  ): Promise<number> {
    if (!this.periods.isValidDateKey(period, dateKey)) {
      throw new RankingPeriodException(`"${dateKey}" is not a valid ${period} date key`);
    }

    const startedAt = Date.now();
    const key = this.store.key(this.ns, scope, dimension, period, dateKey);
    const top = await this.store.top(key, VIDEO_ROOM_RANKING_SNAPSHOT_SIZE);
    if (top.length === 0) return 0;

    const totalEntries = await this.store.count(key);

    const rows: Prisma.VideoRoomRankingSnapshotCreateManyInput[] = top.map((entry, index) => ({
      scope,
      dimension,
      period,
      dateKey,
      targetId: entry.member,
      rank: index + 1,
      // BigInt, not number: a lifetime coin total can exceed 2^53.
      score: BigInt(Math.round(entry.score)),
    }));

    const written = await this.repo.saveRankingSnapshots(rows);

    await this.repo.upsertLeaderboardSnapshot({
      scope,
      dimension,
      period,
      dateKey,
      // Scores as strings: JSON has no BigInt, and a number would silently lose
      // precision on the very totals this column exists to preserve.
      entries: top.map((entry, index) => ({
        targetId: entry.member,
        rank: index + 1,
        score: String(Math.round(entry.score)),
      })) as unknown as Prisma.InputJsonValue,
      totalEntries,
    });

    // Durable now — reclaim the memory.
    await this.store.expire(key, POST_SNAPSHOT_TTL_SECONDS);

    await this.bus.publish(
      new RankingSnapshotCreatedEvent({
        scope,
        dimension,
        period,
        dateKey,
        entriesWritten: written,
        totalEntries,
        durationMs: Date.now() - startedAt,
      }),
    );

    return written;
  }

  /** Snapshot every dimension of the global scope for one closed window. */
  async snapshotAll(period: RankingPeriodName, dateKey: string): Promise<number> {
    let total = 0;
    for (const dimension of Object.values(VideoRoomRankingDimension)) {
      try {
        total += await this.snapshotLadder(scopeGlobal(), dimension, period, dateKey);
      } catch (err) {
        // One dimension failing must not abandon the rest of the window.
        this.logger.error(
          `snapshot ${dimension}:${period}:${dateKey} failed: ${(err as Error).message}`,
        );
      }
    }
    return total;
  }

  /**
   * Retention sweep. Only the high-cardinality short-horizon periods are
   * pruned; monthly, quarterly and yearly rows are small, few, and are exactly
   * what year-over-year reporting reads, so they are retained indefinitely.
   */
  async pruneExpired(): Promise<Record<string, number>> {
    const now = Date.now();
    const results: Record<string, number> = {};

    for (const [period, days] of Object.entries(this.config.retentionDays)) {
      if (!days || days <= 0) continue; // 0 means "never prune"
      const cutoff = new Date(now - days * 86_400_000);
      results[period] = await this.repo.pruneSnapshots(period, cutoff);
    }
    return results;
  }
}
```

- [ ] **Step 4: Write the failing recovery test**

Create `src/modules/video-rooms/services/video-room-ranking-recovery.service.spec.ts`:

```ts
import { VideoRoomRankingDimension } from '../constants/video-room-ranking.constants';
import { VideoRoomRankingRecoveryService } from './video-room-ranking-recovery.service';

describe('VideoRoomRankingRecoveryService', () => {
  const config = { get: () => ({}) } as never;
  let repo: any;
  let store: any;
  let aggregation: { recomputeAll: jest.Mock; recomputeDimension: jest.Mock };
  let service: VideoRoomRankingRecoveryService;

  beforeEach(() => {
    repo = {
      failAggregation: jest.fn().mockResolvedValue(undefined),
      findLeaderboardSnapshot: jest.fn().mockResolvedValue({
        entries: [
          { targetId: 'u1', rank: 1, score: '900' },
          { targetId: 'u2', rank: 2, score: '400' },
        ],
      }),
    };
    store = {
      key: jest.fn((ns, s, d, p, k) => `${ns}:{${s}|${d}}:${p}:${k}`),
      replace: jest.fn().mockResolvedValue(undefined),
      bumpVersion: jest.fn().mockResolvedValue(1),
    };
    aggregation = {
      recomputeAll: jest.fn().mockResolvedValue([{ status: 'RECOMPUTED' }]),
      recomputeDimension: jest.fn().mockResolvedValue({ status: 'RECOMPUTED' }),
    };
    service = new VideoRoomRankingRecoveryService(config, repo, store, aggregation as never);
  });

  describe('replay', () => {
    it('clears the SUCCEEDED guard first so the recompute actually re-runs', async () => {
      await service.replay('daily', '20260722');
      // Every dimension's log row must be invalidated before recomputeAll,
      // or beginAggregation returns ALREADY_SUCCEEDED and the replay no-ops.
      expect(repo.failAggregation).toHaveBeenCalled();
      const failOrder = repo.failAggregation.mock.invocationCallOrder[0];
      const recomputeOrder = aggregation.recomputeAll.mock.invocationCallOrder[0];
      expect(failOrder).toBeLessThan(recomputeOrder);
    });

    it('invalidates the guard for every dimension', async () => {
      await service.replay('daily', '20260722');
      expect(repo.failAggregation).toHaveBeenCalledTimes(
        Object.values(VideoRoomRankingDimension).length,
      );
    });

    it('returns the recompute results', async () => {
      await expect(service.replay('daily', '20260722')).resolves.toEqual([
        { status: 'RECOMPUTED' },
      ]);
    });
  });

  describe('rebuildFromSnapshot', () => {
    it('restores a Redis ladder from its persisted top-N', async () => {
      await expect(
        service.rebuildFromSnapshot('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722'),
      ).resolves.toBe(2);
      expect(store.replace).toHaveBeenCalledWith(
        'vrank:{g|hosts}:daily:20260722',
        [
          { member: 'u1', score: 900 },
          { member: 'u2', score: 400 },
        ],
        expect.any(Number),
      );
    });

    it('parses string scores back to numbers', async () => {
      await service.rebuildFromSnapshot('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722');
      expect(typeof store.replace.mock.calls[0][1][0].score).toBe('number');
    });

    it('returns 0 without touching Redis when no snapshot exists', async () => {
      repo.findLeaderboardSnapshot.mockResolvedValue(null);
      await expect(
        service.rebuildFromSnapshot('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722'),
      ).resolves.toBe(0);
      expect(store.replace).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 5: Implement the recovery service**

Create `src/modules/video-rooms/services/video-room-ranking-recovery.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LeaderboardStore } from 'src/modules/rankings/services/leaderboard-store.service';
import type { RankingPeriodName } from 'src/modules/rankings/services/ranking-period.resolver';
import {
  loadVideoRoomRankingConfig,
  type VideoRoomRankingConfig,
} from '../config/video-room-ranking.config';
import {
  VideoRoomRankingDimension,
  VIDEO_ROOM_RANKING_NAMESPACE,
  scopeGlobal,
} from '../constants/video-room-ranking.constants';
import { VideoRoomRankingRepository } from '../repositories/video-room-ranking.repository';
import {
  VideoRoomRankingAggregationService,
  type AggregationResult,
} from './video-room-ranking-aggregation.service';

/** One persisted leaderboard entry, as stored in the JSON column. */
interface StoredEntry {
  targetId: string;
  rank: number;
  score: string;
}

/**
 * The operator's two recovery levers.
 *
 * `replay` is the answer to "these numbers are wrong": it re-derives a window
 * from the source tables. `rebuildFromSnapshot` is the answer to "Redis lost
 * its data": it restores a ladder from the durable copy, which is far cheaper
 * than a recompute and is what a warm restart wants.
 */
@Injectable()
export class VideoRoomRankingRecoveryService {
  private readonly logger = new Logger(VideoRoomRankingRecoveryService.name);
  private readonly config: VideoRoomRankingConfig;
  private readonly ns = VIDEO_ROOM_RANKING_NAMESPACE;

  constructor(
    config: ConfigService,
    private readonly repo: VideoRoomRankingRepository,
    private readonly store: LeaderboardStore,
    private readonly aggregation: VideoRoomRankingAggregationService,
  ) {
    this.config = loadVideoRoomRankingConfig(config);
  }

  /**
   * Force a window to be recomputed even though it already succeeded.
   *
   * The guard invalidation is not optional and its ORDER matters:
   * `beginAggregation` returns ALREADY_SUCCEEDED for any window with a
   * SUCCEEDED log row, so a replay that did not first knock those rows out of
   * SUCCEEDED would report success while doing precisely nothing — the worst
   * possible outcome for a recovery tool.
   */
  async replay(period: RankingPeriodName, dateKey: string): Promise<AggregationResult[]> {
    this.logger.warn(`replaying rankings for ${period}:${dateKey}`);

    for (const dimension of Object.values(VideoRoomRankingDimension)) {
      await this.repo.failAggregation(
        { scope: scopeGlobal(), dimension, period, dateKey },
        'invalidated by operator replay',
      );
    }

    return this.aggregation.recomputeAll(period, dateKey);
  }

  /** Restore a Redis ladder from its durable top-N. Returns entries restored. */
  async rebuildFromSnapshot(
    scope: string,
    dimension: VideoRoomRankingDimension,
    period: RankingPeriodName,
    dateKey: string,
  ): Promise<number> {
    const snapshot = await this.repo.findLeaderboardSnapshot(scope, dimension, period, dateKey);
    if (!snapshot) {
      this.logger.warn(`no snapshot to rebuild ${scope}:${dimension}:${period}:${dateKey}`);
      return 0;
    }

    const stored = snapshot.entries as unknown as StoredEntry[];
    const entries = stored.map((e) => ({ member: e.targetId, score: Number(e.score) }));

    await this.store.replace(
      this.store.key(this.ns, scope, dimension, period, dateKey),
      entries,
      this.config.derivedLadderTtlSeconds,
    );
    await this.store.bumpVersion(this.ns, scope, dimension);
    return entries.length;
  }
}
```

- [ ] **Step 6: Run both suites and lint**

```bash
pnpm test -- src/modules/video-rooms/services/video-room-ranking-snapshot.service.spec.ts src/modules/video-rooms/services/video-room-ranking-recovery.service.spec.ts
pnpm lint
```

Expected: PASS; lint exit 0.

- [ ] **Step 7: Report and stop.** **Do not commit.**

---

## Task 15: JobsService + Scheduler

**Files:**
- Create: `src/modules/video-rooms/services/video-room-ranking-jobs.service.ts`
- Test: `src/modules/video-rooms/services/video-room-ranking-jobs.service.spec.ts`
- Create: `src/modules/video-rooms/scheduler/video-room-ranking.scheduler.ts`
- Test: `src/modules/video-rooms/scheduler/video-room-ranking.scheduler.spec.ts`

**Interfaces:**
- Consumes: `QueueJobRegistry`, `QueueService`, `QUEUE_NAMES.RANKING_PROCESSING`, `LockService`, aggregation/snapshot services (Tasks 13–14), `VIDEO_ROOM_RANKING_JOBS` (Task 6).
- Produces:
  - `interface RankingAggregateJob { period: RankingPeriodName; dateKey?: string }`
  - `class VideoRoomRankingJobsService implements OnModuleInit` with `handleAggregate`, `handleCacheRefresh`, `handleCleanup`
  - `class VideoRoomRankingScheduler implements OnModuleInit`

- [ ] **Step 1: Write the failing jobs test**

Create `src/modules/video-rooms/services/video-room-ranking-jobs.service.spec.ts`:

```ts
import { VIDEO_ROOM_RANKING_JOBS } from '../constants/video-room-ranking.constants';
import { VideoRoomRankingJobsService } from './video-room-ranking-jobs.service';

describe('VideoRoomRankingJobsService', () => {
  let registered: Record<string, (data: unknown) => Promise<unknown>>;
  let registry: { register: jest.Mock };
  let locks: { acquire: jest.Mock };
  let aggregation: { recomputeAll: jest.Mock; derivePeriod: jest.Mock };
  let snapshots: { snapshotAll: jest.Mock; pruneExpired: jest.Mock };
  let service: VideoRoomRankingJobsService;

  beforeEach(() => {
    registered = {};
    registry = {
      register: jest.fn((_q: string, name: string, h: (d: unknown) => Promise<unknown>) => {
        registered[name] = h;
      }),
    };
    // `acquire` resolves to a release fn when the lock is taken, or null when
    // it is held elsewhere. It never throws and never retries — see the note in
    // the implementation step on why withLock is deliberately NOT used here.
    locks = { acquire: jest.fn().mockResolvedValue(jest.fn().mockResolvedValue(undefined)) };
    aggregation = {
      recomputeAll: jest.fn().mockResolvedValue([{ status: 'RECOMPUTED', entriesWritten: 3 }]),
      derivePeriod: jest.fn().mockResolvedValue(4),
    };
    snapshots = {
      snapshotAll: jest.fn().mockResolvedValue(12),
      pruneExpired: jest.fn().mockResolvedValue({ hourly: 5 }),
    };
    service = new VideoRoomRankingJobsService(
      registry as never,
      locks as never,
      aggregation as never,
      snapshots as never,
    );
    service.onModuleInit();
  });

  it('registers all seven jobs on the ranking-processing queue', () => {
    expect(Object.keys(registered).sort()).toEqual(Object.values(VIDEO_ROOM_RANKING_JOBS).sort());
    expect(registry.register.mock.calls.every((c) => c[0] === 'ranking-processing')).toBe(true);
  });

  describe('aggregate jobs', () => {
    it('takes a fleet-wide lock before doing work', async () => {
      await registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_DAILY]({ dateKey: '20260722' });
      expect(locks.acquire).toHaveBeenCalledWith(
        expect.stringContaining('vrank:agg:lock:'),
        expect.any(Number),
      );
    });

    it('releases the lock even when the recompute throws', async () => {
      const release = jest.fn().mockResolvedValue(undefined);
      locks.acquire.mockResolvedValue(release);
      aggregation.recomputeAll.mockRejectedValue(new Error('db down'));
      await expect(
        registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_DAILY]({ dateKey: '20260722' }),
      ).rejects.toThrow();
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('recomputes then snapshots for a daily window', async () => {
      await registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_DAILY]({ dateKey: '20260722' });
      expect(aggregation.recomputeAll).toHaveBeenCalledWith('daily', '20260722');
      expect(snapshots.snapshotAll).toHaveBeenCalledWith('daily', '20260722');
    });

    it('defaults to the PREVIOUS window when no dateKey is supplied', async () => {
      // A cron firing at 00:10 must close YESTERDAY, not the day just begun.
      await registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_DAILY]({});
      const dateKey = aggregation.recomputeAll.mock.calls[0][1];
      const today = new Date();
      const yyyymmdd = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, '0')}${String(today.getUTCDate()).padStart(2, '0')}`;
      expect(dateKey).not.toBe(yyyymmdd);
      expect(dateKey).toMatch(/^\d{8}$/);
    });

    it('does not snapshot an hourly window — too many rows, too little value', async () => {
      await registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_HOURLY]({ dateKey: '2026072213' });
      expect(aggregation.recomputeAll).toHaveBeenCalledWith('hourly', '2026072213');
      expect(snapshots.snapshotAll).not.toHaveBeenCalled();
    });

    it('derives the quarter after a monthly close', async () => {
      await registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_MONTHLY]({ dateKey: '202607' });
      expect(aggregation.derivePeriod).toHaveBeenCalledWith(
        expect.any(String),
        'quarterly',
        '2026Q3',
      );
    });

    it('returns quietly when the lock is held elsewhere, without retrying', async () => {
      locks.acquire.mockResolvedValue(null);
      await expect(
        registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_DAILY]({ dateKey: '20260722' }),
      ).resolves.toEqual({ skipped: 'locked' });
      expect(aggregation.recomputeAll).not.toHaveBeenCalled();
      expect(locks.acquire).toHaveBeenCalledTimes(1);
    });

    it('propagates a real failure so BullMQ retries and eventually dead-letters', async () => {
      aggregation.recomputeAll.mockRejectedValue(new Error('db down'));
      await expect(
        registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_DAILY]({ dateKey: '20260722' }),
      ).rejects.toThrow('db down');
    });
  });

  describe('cleanup', () => {
    it('prunes expired snapshots', async () => {
      await expect(registered[VIDEO_ROOM_RANKING_JOBS.CLEANUP]({})).resolves.toEqual({
        pruned: { hourly: 5 },
      });
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm test -- src/modules/video-rooms/services/video-room-ranking-jobs.service.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the jobs service**

Create `src/modules/video-rooms/services/video-room-ranking-jobs.service.ts`:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import { LockService } from 'src/infra/redis/lock.service';
import {
  RankingPeriodResolver,
  type RankingPeriodName,
} from 'src/modules/rankings/services/ranking-period.resolver';
import {
  VideoRoomRankingDimension,
  VIDEO_ROOM_RANKING_JOBS,
  videoRoomRankingAggregationLockKey,
} from '../constants/video-room-ranking.constants';
import { VideoRoomRankingAggregationService } from './video-room-ranking-aggregation.service';
import { VideoRoomRankingSnapshotService } from './video-room-ranking-snapshot.service';

export interface RankingAggregateJob {
  /** Omitted by the cron; supplied when replaying a specific window. */
  dateKey?: string;
}

/** Lock lifetime — generous, because a monthly recompute scans a lot of rows. */
const AGGREGATION_LOCK_MS = 10 * 60_000;

/** Periods worth persisting. Hourly is recomputed but never snapshotted. */
const SNAPSHOT_PERIODS: readonly RankingPeriodName[] = ['daily', 'weekly', 'monthly', 'yearly'];

/**
 * The seven BullMQ handlers, registered on the shared RANKING_PROCESSING queue
 * through {@link QueueJobRegistry} — the same seam VR-12's PK timers use on the
 * gift queue. No new queue is created.
 *
 * Every aggregate job is guarded twice, for two different failure modes. The
 * fleet-wide `LockService` lock stops two LIVE instances from recomputing the
 * same window simultaneously. The aggregation log's SUCCEEDED row (checked
 * inside the service) stops a REDELIVERED job from redoing finished work. Each
 * covers a case the other cannot.
 *
 * Handlers distinguish "nothing to do" from "failed": a held lock returns
 * quietly, while a genuine error is rethrown so BullMQ's retry and dead-letter
 * path stays meaningful. This is the VR-12 jobs-service convention.
 */
@Injectable()
export class VideoRoomRankingJobsService implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomRankingJobsService.name);
  private readonly periods = new RankingPeriodResolver();

  constructor(
    private readonly registry: QueueJobRegistry,
    private readonly locks: LockService,
    private readonly aggregation: VideoRoomRankingAggregationService,
    private readonly snapshots: VideoRoomRankingSnapshotService,
  ) {}

  onModuleInit(): void {
    const q = QUEUE_NAMES.RANKING_PROCESSING;
    const bind = (period: RankingPeriodName) => (data: unknown) =>
      this.handleAggregate(period, data as RankingAggregateJob);

    this.registry.register(q, VIDEO_ROOM_RANKING_JOBS.AGGREGATE_HOURLY, bind('hourly'));
    this.registry.register(q, VIDEO_ROOM_RANKING_JOBS.AGGREGATE_DAILY, bind('daily'));
    this.registry.register(q, VIDEO_ROOM_RANKING_JOBS.AGGREGATE_WEEKLY, bind('weekly'));
    this.registry.register(q, VIDEO_ROOM_RANKING_JOBS.AGGREGATE_MONTHLY, bind('monthly'));
    this.registry.register(q, VIDEO_ROOM_RANKING_JOBS.AGGREGATE_YEARLY, bind('yearly'));
    this.registry.register(q, VIDEO_ROOM_RANKING_JOBS.CACHE_REFRESH, () =>
      this.handleCacheRefresh(),
    );
    this.registry.register(q, VIDEO_ROOM_RANKING_JOBS.CLEANUP, () => this.handleCleanup());
  }

  /**
   * The PREVIOUS window's key. A cron that fires at 00:10 to close "yesterday"
   * would otherwise aggregate the ten minutes of today that have elapsed — and
   * then mark that partial window SUCCEEDED, permanently.
   */
  private previousWindowKey(period: RankingPeriodName): string {
    const now = Date.now();
    const backoff: Partial<Record<RankingPeriodName, number>> = {
      hourly: 3_600_000,
      daily: 86_400_000,
      weekly: 7 * 86_400_000,
      monthly: 28 * 86_400_000,
      yearly: 365 * 86_400_000,
    };
    return this.periods.dateKeyFor(period, new Date(now - (backoff[period] ?? 86_400_000)));
  }

  async handleAggregate(period: RankingPeriodName, job: RankingAggregateJob): Promise<unknown> {
    const dateKey = job.dateKey ?? this.previousWindowKey(period);
    const lockKey = videoRoomRankingAggregationLockKey(`${period}:${dateKey}`);

    /*
     * `acquire`, deliberately NOT `withLock`.
     *
     * `LockService.withLock` retries 20 times at 100ms and then THROWS if it
     * still cannot take the lock. Both halves of that are wrong here. A lock
     * held by a peer means another instance is already aggregating this exact
     * window — there is nothing to wait for and nothing to retry, so blocking
     * two seconds is pure latency. And throwing would hand BullMQ a "failure"
     * for a job that did its correct thing, burning retries and eventually
     * dead-lettering a healthy schedule.
     *
     * `acquire` resolves to null instead of throwing, which is exactly the
     * "someone else has it, stand down" signal this needs.
     */
    const release = await this.locks.acquire(lockKey, AGGREGATION_LOCK_MS);
    if (!release) {
      this.logger.debug(`aggregation ${period}:${dateKey} locked elsewhere — skipping`);
      return { skipped: 'locked' };
    }

    try {
      const results = await this.aggregation.recomputeAll(period, dateKey);

      if (SNAPSHOT_PERIODS.includes(period)) {
        await this.snapshots.snapshotAll(period, dateKey);
      }

      // A closed month completes a quarter; a closed year is itself derived.
      if (period === 'monthly') {
        const quarterKey = this.periods.dateKeyFor(
          'quarterly',
          this.periods.windowFor('monthly', dateKey).start,
        );
        for (const dimension of Object.values(VideoRoomRankingDimension)) {
          await this.aggregation.derivePeriod(dimension, 'quarterly', quarterKey);
        }
      }

      return {
        period,
        dateKey,
        recomputed: results.filter((r) => r.status === 'RECOMPUTED').length,
        skipped: results.filter((r) => r.status === 'SKIPPED').length,
      };
    } finally {
      // `finally`, so a thrown recompute still frees the window for the retry.
      // A leaked lock would block this dateKey for the full 10-minute TTL.
      try {
        await release();
      } catch (err) {
        this.logger.warn(`failed to release ${lockKey}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Warms nothing eagerly today: cached pages are populated read-through by the
   * query service, and the version stamp already guarantees correctness. This
   * handler exists so the scheduled job has an owner and so a future warm-up
   * has an obvious home — it deliberately does no speculative work rather than
   * pre-rendering pages nobody may request.
   */
  async handleCacheRefresh(): Promise<unknown> {
    return { refreshed: 0 };
  }

  async handleCleanup(): Promise<unknown> {
    return { pruned: await this.snapshots.pruneExpired() };
  }
}
```

- [ ] **Step 4: Write the failing scheduler test**

Create `src/modules/video-rooms/scheduler/video-room-ranking.scheduler.spec.ts`:

```ts
import { VIDEO_ROOM_RANKING_JOBS } from '../constants/video-room-ranking.constants';
import { VideoRoomRankingScheduler } from './video-room-ranking.scheduler';

describe('VideoRoomRankingScheduler', () => {
  let queue: { schedule: jest.Mock };
  let scheduler: VideoRoomRankingScheduler;

  beforeEach(() => {
    queue = { schedule: jest.fn().mockResolvedValue({}) };
    scheduler = new VideoRoomRankingScheduler(queue as never);
  });

  it('schedules all seven repeatable jobs on the ranking queue', async () => {
    await scheduler.onModuleInit();
    expect(queue.schedule).toHaveBeenCalledTimes(7);
    const names = queue.schedule.mock.calls.map((c) => c[1]);
    expect(names.sort()).toEqual(Object.values(VIDEO_ROOM_RANKING_JOBS).sort());
    expect(queue.schedule.mock.calls.every((c) => c[0] === 'ranking-processing')).toBe(true);
  });

  it('gives every job a stable jobId so restarts do not duplicate schedules', async () => {
    await scheduler.onModuleInit();
    const ids = queue.schedule.mock.calls.map((c) => c[4]?.jobId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(7);
  });

  it('offsets each cron so aggregations do not all fire at midnight', async () => {
    await scheduler.onModuleInit();
    const patterns = queue.schedule.mock.calls.map((c) => c[3].pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it('logs and continues when scheduling fails — a boot must not be blocked', async () => {
    queue.schedule.mockRejectedValue(new Error('redis down'));
    await expect(scheduler.onModuleInit()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 5: Implement the scheduler**

Create `src/modules/video-rooms/scheduler/video-room-ranking.scheduler.ts`:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { VIDEO_ROOM_RANKING_JOBS } from '../constants/video-room-ranking.constants';

/**
 * Cron patterns are staggered on purpose. Every one of these fires shortly
 * after a period boundary, and an unstaggered set would put the hourly, daily,
 * weekly, monthly and yearly recomputes on the same tick at 00:00 on New
 * Year's Day — the single busiest moment of the year for a gifting platform.
 * The offsets also give the previous window time to settle before it is read.
 */
const SCHEDULE: { name: string; pattern: string; jobId: string }[] = [
  { name: VIDEO_ROOM_RANKING_JOBS.AGGREGATE_HOURLY, pattern: '2 * * * *', jobId: 'vrank-hourly' },
  { name: VIDEO_ROOM_RANKING_JOBS.AGGREGATE_DAILY, pattern: '10 0 * * *', jobId: 'vrank-daily' },
  { name: VIDEO_ROOM_RANKING_JOBS.AGGREGATE_WEEKLY, pattern: '20 0 * * 1', jobId: 'vrank-weekly' },
  { name: VIDEO_ROOM_RANKING_JOBS.AGGREGATE_MONTHLY, pattern: '30 0 1 * *', jobId: 'vrank-monthly' },
  { name: VIDEO_ROOM_RANKING_JOBS.AGGREGATE_YEARLY, pattern: '40 0 1 1 *', jobId: 'vrank-yearly' },
  { name: VIDEO_ROOM_RANKING_JOBS.CACHE_REFRESH, pattern: '*/2 * * * *', jobId: 'vrank-cache' },
  { name: VIDEO_ROOM_RANKING_JOBS.CLEANUP, pattern: '50 3 * * *', jobId: 'vrank-cleanup' },
];

/**
 * Registers the VR-13 repeatable jobs, mirroring `RankingsScheduler`.
 *
 * A fixed `jobId` per entry is what makes this idempotent across restarts and
 * across every instance in the fleet: BullMQ treats a repeatable job with the
 * same id as the same schedule rather than adding another one, so a ten-pod
 * deployment ends up with one hourly aggregation, not ten.
 */
@Injectable()
export class VideoRoomRankingScheduler implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomRankingScheduler.name);

  constructor(private readonly queue: QueueService) {}

  async onModuleInit(): Promise<void> {
    for (const { name, pattern, jobId } of SCHEDULE) {
      try {
        await this.queue.schedule(
          QUEUE_NAMES.RANKING_PROCESSING,
          name,
          {},
          { pattern },
          { jobId, removeOnComplete: true, removeOnFail: true },
        );
        this.logger.log(`scheduled ${name} (${pattern})`);
      } catch (err) {
        // Never block boot on a scheduling failure — the app must still serve
        // reads even if the queue is briefly unreachable at startup.
        this.logger.error(`failed to schedule ${name}: ${(err as Error).message}`);
      }
    }
  }
}
```

- [ ] **Step 6: Run both suites and lint**

```bash
pnpm test -- src/modules/video-rooms/services/video-room-ranking-jobs.service.spec.ts src/modules/video-rooms/scheduler/video-room-ranking.scheduler.spec.ts
pnpm lint
```

Expected: PASS; lint exit 0.

- [ ] **Step 7: Report and stop.** **Do not commit.**

---

## Task 16: QueryService + LeaderboardService

**Files:**
- Create: `src/modules/video-rooms/services/video-room-ranking-query.service.ts`
- Test: `src/modules/video-rooms/services/video-room-ranking-query.service.spec.ts`
- Create: `src/modules/video-rooms/services/video-room-leaderboard.service.ts`
- Test: `src/modules/video-rooms/services/video-room-leaderboard.service.spec.ts`

**Interfaces:**
- Consumes: `LeaderboardStore`, `LeaderboardCache`, `RankingPeriodResolver`, `VideoRoomRankingRepository`, constants/config/exceptions, `SOCIAL_SERVICE`/`ISocialService`, `VIP_SERVICE`/`IVipService`, `buildPaginated`, `AuthenticatedUser`.
- Produces:
  - `interface RankingViewer { id: string; isGuest: boolean }`
  - `interface RankingQuery { dimension; period; dateKey?; scope?; limit; page }`
  - `class VideoRoomRankingQueryService` with `getLadder(viewer, query): Promise<Paginated<RankingEntryDto>>`, `getSelfRank(viewer, dimension, period): Promise<SelfRankDto>`, `getHistory(viewer, targetId, dimension, period, limit)`
  - `class VideoRoomLeaderboardService` with `projectAudience(viewer, query, audience): Promise<Paginated<RankingEntryDto>>`

- [ ] **Step 1: Write the failing query test**

Create `src/modules/video-rooms/services/video-room-ranking-query.service.spec.ts`:

```ts
import { RankingPeriodResolver } from 'src/modules/rankings/services/ranking-period.resolver';
import { VideoRoomRankingDimension } from '../constants/video-room-ranking.constants';
import { VideoRoomRankingQueryService } from './video-room-ranking-query.service';

const MEMBER = { id: 'u1', isGuest: false };
const GUEST = { id: 'g1', isGuest: true };
const query = (over = {}) => ({
  dimension: VideoRoomRankingDimension.HOSTS,
  period: 'daily' as const,
  limit: 20,
  page: 1,
  ...over,
});

describe('VideoRoomRankingQueryService', () => {
  const config = { get: () => ({}) } as never;
  let store: any;
  let cache: { read: jest.Mock; write: jest.Mock };
  let repo: any;
  let service: VideoRoomRankingQueryService;

  beforeEach(() => {
    store = {
      key: jest.fn((ns, s, d, p, k) => `${ns}:{${s}|${d}}:${p}:${k}`),
      range: jest.fn().mockResolvedValue([
        { member: 'u1', score: 900 },
        { member: 'u2', score: 400 },
      ]),
      count: jest.fn().mockResolvedValue(2),
      rank: jest.fn().mockResolvedValue(0),
      score: jest.fn().mockResolvedValue(900),
    };
    cache = { read: jest.fn().mockResolvedValue(null), write: jest.fn().mockResolvedValue(undefined) };
    repo = {
      findRankingSnapshots: jest.fn().mockResolvedValue([[], 0]),
      findLeaderboardSnapshot: jest.fn().mockResolvedValue(null),
      findTargetHistory: jest.fn().mockResolvedValue([]),
      hydrateTargets: jest.fn().mockResolvedValue([
        { id: 'u1', username: 'alice', avatarKey: 'a.png', level: 3, vipLevel: 1 },
        { id: 'u2', username: 'bob', avatarKey: null, level: 2, vipLevel: 0 },
      ]),
    };
    service = new VideoRoomRankingQueryService(
      config,
      store,
      cache as never,
      new RankingPeriodResolver(),
      repo,
    );
  });

  describe('getLadder', () => {
    it('returns hydrated, 1-based ranked entries', async () => {
      const result = await service.getLadder(MEMBER, query());
      expect(result.items[0]).toEqual(
        expect.objectContaining({ rank: 1, targetId: 'u1', username: 'alice', score: 900 }),
      );
      expect(result.items[1].rank).toBe(2);
    });

    it('continues ranks across pages rather than restarting at 1', async () => {
      const result = await service.getLadder(MEMBER, query({ page: 3, limit: 20 }));
      expect(result.items[0].rank).toBe(41);
    });

    it('serves a cache hit without touching Redis ZSETs', async () => {
      cache.read.mockResolvedValue({ items: [{ rank: 1, targetId: 'u1' }], total: 1 });
      const result = await service.getLadder(MEMBER, query());
      expect(store.range).not.toHaveBeenCalled();
      expect(result.items).toEqual([{ rank: 1, targetId: 'u1' }]);
    });

    it('writes the page to cache on a miss', async () => {
      await service.getLadder(MEMBER, query());
      expect(cache.write).toHaveBeenCalled();
    });

    it('caps a guest at the top ten', async () => {
      await service.getLadder(GUEST, query({ limit: 100 }));
      // start 0, stop 9 — never beyond rank 10.
      expect(store.range).toHaveBeenCalledWith(expect.any(String), 0, 9);
    });

    it('refuses a guest any page beyond the first', async () => {
      await expect(service.getLadder(GUEST, query({ page: 2 }))).rejects.toThrow();
    });

    it('refuses a guest a historical dateKey', async () => {
      await expect(service.getLadder(GUEST, query({ dateKey: '20260701' }))).rejects.toThrow();
    });

    it('rejects an unknown dimension', async () => {
      await expect(
        service.getLadder(MEMBER, query({ dimension: 'families' as never })),
      ).rejects.toThrow();
    });

    it('rejects a malformed dateKey with a 400-class error', async () => {
      await expect(service.getLadder(MEMBER, query({ dateKey: '2026-07-22' }))).rejects.toThrow();
    });

    it('reads a closed window from snapshots instead of Redis', async () => {
      repo.findRankingSnapshots.mockResolvedValue([
        [{ targetId: 'u1', rank: 1, score: 900n, metrics: null }],
        1,
      ]);
      const result = await service.getLadder(MEMBER, query({ dateKey: '20260101' }));
      expect(repo.findRankingSnapshots).toHaveBeenCalled();
      expect(store.range).not.toHaveBeenCalled();
      expect(result.items[0].targetId).toBe('u1');
    });

    it('falls back to the durable snapshot when Redis is unavailable', async () => {
      store.range.mockRejectedValue(new Error('CONNRESET'));
      repo.findLeaderboardSnapshot.mockResolvedValue({
        entries: [{ targetId: 'u1', rank: 1, score: '900' }],
        totalEntries: 1,
      });
      const result = await service.getLadder(MEMBER, query());
      // A stale ladder beats a 500.
      expect(result.items[0].targetId).toBe('u1');
    });
  });

  describe('getSelfRank', () => {
    it('returns a 1-based rank for a member', async () => {
      const self = await service.getSelfRank(MEMBER, VideoRoomRankingDimension.HOSTS, 'daily');
      expect(self).toEqual(expect.objectContaining({ rank: 1, score: 900 }));
    });

    it('returns null rank when the member is not on the ladder', async () => {
      store.rank.mockResolvedValue(null);
      const self = await service.getSelfRank(MEMBER, VideoRoomRankingDimension.HOSTS, 'daily');
      expect(self.rank).toBeNull();
    });

    it('refuses a guest entirely', async () => {
      await expect(
        service.getSelfRank(GUEST, VideoRoomRankingDimension.HOSTS, 'daily'),
      ).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 2: Add `hydrateTargets` to the repository**

The query test mocks `repo.hydrateTargets`. Add it to `VideoRoomRankingRepository` (Task 9's file):

```ts
  /**
   * Resolve display data for ladder members in one pass. Rooms and users are
   * both possible members, so `kind` selects which table to read — a `rooms`
   * ladder holds room ids and would return nothing from `user`.
   */
  async hydrateTargets(
    ids: string[],
    kind: 'user' | 'room',
  ): Promise<
    {
      id: string;
      username: string;
      avatarKey: string | null;
      level: number;
      vipLevel: number;
    }[]
  > {
    if (ids.length === 0) return [];

    if (kind === 'room') {
      const rooms = await this.prisma.videoRoom.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, coverKey: true },
      });
      return rooms.map((r) => ({
        id: r.id,
        username: r.name,
        avatarKey: r.coverKey ?? null,
        level: 0,
        vipLevel: 0,
      }));
    }

    const [users, profiles, stats] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, username: true },
      }),
      this.prisma.userProfile.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, avatarKey: true },
      }),
      this.prisma.userStatistics.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, level: true, vipLevel: true },
      }),
    ]);
    const avatarById = new Map(profiles.map((p) => [p.userId, p.avatarKey]));
    const statById = new Map(stats.map((s) => [s.userId, s]));
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      avatarKey: avatarById.get(u.id) ?? null,
      level: statById.get(u.id)?.level ?? 1,
      vipLevel: statById.get(u.id)?.vipLevel ?? 0,
    }));
  }
```

Verify the `VideoRoom` column used for the cover image before writing this:

```bash
grep -n "coverKey\|thumbnailKey\|imageKey" prisma/schema/video_rooms.prisma | head
```

Use whatever column exists; if none does, drop `avatarKey` to `null` for rooms.

- [ ] **Step 3: Run the query test to verify it fails**

```bash
pnpm test -- src/modules/video-rooms/services/video-room-ranking-query.service.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement the query service**

Create `src/modules/video-rooms/services/video-room-ranking-query.service.ts`:

```ts
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { LeaderboardCache } from 'src/modules/rankings/services/leaderboard-cache.service';
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
  VIDEO_ROOM_RANKING_GUEST_LIMIT,
  VIDEO_ROOM_RANKING_MAX_PAGE_SIZE,
  VIDEO_ROOM_RANKING_NAMESPACE,
  isRankingDimension,
  scopeGlobal,
} from '../constants/video-room-ranking.constants';
import {
  RankingException,
  RankingPeriodException,
} from '../exceptions/video-room-ranking.exceptions';
import { VideoRoomRankingRepository } from '../repositories/video-room-ranking.repository';

/** The minimum a read path needs to know about who is asking. */
export interface RankingViewer {
  id: string;
  isGuest: boolean;
}

export interface RankingQuery {
  dimension: VideoRoomRankingDimension;
  period: RankingPeriodName;
  /** Omitted means "the current window". */
  dateKey?: string;
  /** Omitted means global. */
  scope?: string;
  limit: number;
  page: number;
}

export interface RankingEntryDto {
  rank: number;
  targetId: string;
  username: string;
  avatarKey: string | null;
  score: number;
  level: number;
  vipLevel: number;
}

export interface SelfRankDto {
  dimension: string;
  period: string;
  dateKey: string;
  /** Null when the viewer has no score on this ladder. */
  rank: number | null;
  score: number;
}

/** Dimensions whose members are rooms rather than users. */
const ROOM_MEMBER_DIMENSIONS = new Set<string>([VideoRoomRankingDimension.ROOMS]);

/**
 * The VR-13 read path.
 *
 * Reads resolve in a strict order of preference: cached hydrated page → live
 * Redis ladder → durable snapshot. The last step is what keeps a leaderboard
 * screen working during a Redis incident — a ladder that is an hour stale is a
 * far better answer than a 500, and this is a read-only, non-financial surface
 * where that trade is clearly correct.
 *
 * Authorization lives here rather than in the controller, matching the
 * VR-10/11/12 convention.
 */
@Injectable()
export class VideoRoomRankingQueryService {
  private readonly logger = new Logger(VideoRoomRankingQueryService.name);
  private readonly config: VideoRoomRankingConfig;
  private readonly ns = VIDEO_ROOM_RANKING_NAMESPACE;

  constructor(
    config: ConfigService,
    private readonly store: LeaderboardStore,
    private readonly cache: LeaderboardCache,
    private readonly periods: RankingPeriodResolver,
    private readonly repo: VideoRoomRankingRepository,
  ) {
    this.config = loadVideoRoomRankingConfig(config);
  }

  async getLadder(viewer: RankingViewer, query: RankingQuery): Promise<Paginated<RankingEntryDto>> {
    const { dimension, period } = query;

    if (!isRankingDimension(dimension)) {
      throw new RankingException(`unknown ranking dimension "${dimension}"`, HttpStatus.BAD_REQUEST);
    }

    // Guest gate, applied before anything is read.
    if (viewer.isGuest) {
      if (query.page > 1) {
        throw new RankingException(
          'guests may read only the first page of a leaderboard',
          HttpStatus.FORBIDDEN,
        );
      }
      if (query.dateKey) {
        throw new RankingException(
          'guests may not read historical leaderboards',
          HttpStatus.FORBIDDEN,
        );
      }
    }

    const dateKey = query.dateKey ?? this.periods.dateKeyFor(period, new Date());
    if (!this.periods.isValidDateKey(period, dateKey)) {
      throw new RankingPeriodException(`"${dateKey}" is not a valid ${period} date key`);
    }

    const scope = query.scope ?? scopeGlobal();
    const limit = viewer.isGuest
      ? Math.min(query.limit, VIDEO_ROOM_RANKING_GUEST_LIMIT)
      : Math.min(query.limit, VIDEO_ROOM_RANKING_MAX_PAGE_SIZE);
    const start = (query.page - 1) * limit;
    const stop = viewer.isGuest
      ? Math.min(start + limit, VIDEO_ROOM_RANKING_GUEST_LIMIT) - 1
      : start + limit - 1;

    const cached = await this.cache.read<Paginated<RankingEntryDto>>(
      this.ns,
      scope,
      dimension,
      period,
      dateKey,
      query.page,
    );
    if (cached) return cached;

    // A closed window is answered from the durable record, not from a Redis
    // ladder that has since been TTL'd away.
    const current = this.periods.dateKeyFor(period, new Date());
    const isClosed = period !== 'alltime' && dateKey !== current;

    const { entries, total } = isClosed
      ? await this.fromSnapshots(scope, dimension, period, dateKey, start, limit)
      : await this.fromRedis(scope, dimension, period, dateKey, start, stop);

    const items = await this.hydrate(entries, dimension, start);
    const page = buildPaginated(items, total, query.page, limit);

    await this.cache.write(
      this.ns,
      scope,
      dimension,
      period,
      dateKey,
      query.page,
      page,
      this.config.cacheTtlSeconds,
    );
    return page;
  }

  private async fromRedis(
    scope: string,
    dimension: string,
    period: string,
    dateKey: string,
    start: number,
    stop: number,
  ): Promise<{ entries: RankedEntry[]; total: number }> {
    const key = this.store.key(this.ns, scope, dimension, period, dateKey);
    try {
      const [entries, total] = await Promise.all([
        this.store.range(key, start, stop),
        this.store.count(key),
      ]);
      return { entries, total };
    } catch (err) {
      // Degrade to the durable copy rather than failing the request.
      this.logger.warn(`redis ladder read failed for ${key}: ${(err as Error).message}`);
      const snapshot = await this.repo.findLeaderboardSnapshot(scope, dimension, period, dateKey);
      if (!snapshot) return { entries: [], total: 0 };
      const stored = snapshot.entries as unknown as {
        targetId: string;
        score: string;
      }[];
      return {
        entries: stored.slice(start, stop + 1).map((e) => ({
          member: e.targetId,
          score: Number(e.score),
        })),
        total: snapshot.totalEntries,
      };
    }
  }

  private async fromSnapshots(
    scope: string,
    dimension: string,
    period: string,
    dateKey: string,
    skip: number,
    take: number,
  ): Promise<{ entries: RankedEntry[]; total: number }> {
    const [rows, total] = await this.repo.findRankingSnapshots(
      scope,
      dimension,
      period,
      dateKey,
      skip,
      take,
    );
    return {
      entries: rows.map((r) => ({ member: r.targetId, score: Number(r.score) })),
      total,
    };
  }

  private async hydrate(
    entries: RankedEntry[],
    dimension: string,
    start: number,
  ): Promise<RankingEntryDto[]> {
    if (entries.length === 0) return [];
    const kind = ROOM_MEMBER_DIMENSIONS.has(dimension) ? 'room' : 'user';
    const details = await this.repo.hydrateTargets(
      entries.map((e) => e.member),
      kind,
    );
    const byId = new Map(details.map((d) => [d.id, d]));

    return entries.map((entry, index) => {
      const detail = byId.get(entry.member);
      return {
        // `start + index + 1`: ranks continue across pages rather than
        // restarting at 1 on page 2.
        rank: start + index + 1,
        targetId: entry.member,
        username: detail?.username ?? 'Unknown',
        avatarKey: detail?.avatarKey ?? null,
        score: entry.score,
        level: detail?.level ?? 1,
        vipLevel: detail?.vipLevel ?? 0,
      };
    });
  }

  async getSelfRank(
    viewer: RankingViewer,
    dimension: VideoRoomRankingDimension,
    period: RankingPeriodName,
    scope: string = scopeGlobal(),
  ): Promise<SelfRankDto> {
    if (viewer.isGuest) {
      throw new RankingException('guests have no ranking position', HttpStatus.FORBIDDEN);
    }
    const dateKey = this.periods.dateKeyFor(period, new Date());
    const key = this.store.key(this.ns, scope, dimension, period, dateKey);
    const [rank, score] = await Promise.all([
      this.store.rank(key, viewer.id),
      this.store.score(key, viewer.id),
    ]);
    return {
      dimension,
      period,
      dateKey,
      // ZREVRANK is 0-based; the API is 1-based. Null stays null — "unranked"
      // is meaningfully different from "rank 1".
      rank: rank === null ? null : rank + 1,
      score: score ?? 0,
    };
  }

  async getHistory(
    viewer: RankingViewer,
    targetId: string,
    dimension: VideoRoomRankingDimension,
    period: RankingPeriodName,
    limit: number,
  ): Promise<{ dateKey: string; rank: number; score: number }[]> {
    if (viewer.isGuest) {
      throw new RankingException('guests may not read ranking history', HttpStatus.FORBIDDEN);
    }
    const rows = await this.repo.findTargetHistory(targetId, dimension, period, limit);
    return rows.map((r) => ({ dateKey: r.dateKey, rank: r.rank, score: Number(r.score) }));
  }
}
```

- [ ] **Step 5: Write the failing leaderboard-projection test**

Create `src/modules/video-rooms/services/video-room-leaderboard.service.spec.ts`:

```ts
import { RankingPeriodResolver } from 'src/modules/rankings/services/ranking-period.resolver';
import { VideoRoomRankingDimension } from '../constants/video-room-ranking.constants';
import { VideoRoomLeaderboardService } from './video-room-leaderboard.service';

const VIEWER = { id: 'me', isGuest: false };

describe('VideoRoomLeaderboardService', () => {
  let store: any;
  let social: { friendIds: jest.Mock; followerIds: jest.Mock };
  let repo: { hydrateTargets: jest.Mock };
  let service: VideoRoomLeaderboardService;

  beforeEach(() => {
    store = {
      key: jest.fn((ns, s, d, p, k) => `${ns}:{${s}|${d}}:${p}:${k}`),
      scoreMany: jest.fn().mockResolvedValue([300, null, 900]),
    };
    social = {
      friendIds: jest.fn().mockResolvedValue(['f1', 'f2', 'f3']),
      followerIds: jest.fn().mockResolvedValue(['x1']),
    };
    repo = {
      hydrateTargets: jest.fn().mockResolvedValue([
        { id: 'f1', username: 'a', avatarKey: null, level: 1, vipLevel: 0 },
        { id: 'f3', username: 'c', avatarKey: null, level: 1, vipLevel: 0 },
      ]),
    };
    service = new VideoRoomLeaderboardService(
      store,
      new RankingPeriodResolver(),
      social as never,
      repo as never,
    );
  });

  const query = () => ({
    dimension: VideoRoomRankingDimension.GIFTERS,
    period: 'daily' as const,
    limit: 20,
    page: 1,
  });

  it('projects the friend set onto the ladder with ZMSCORE, not a separate ZSET', async () => {
    await service.projectAudience(VIEWER, query(), 'friends');
    expect(store.scoreMany).toHaveBeenCalledWith(expect.any(String), ['f1', 'f2', 'f3']);
  });

  it('drops friends with no score rather than ranking them at zero', async () => {
    const page = await service.projectAudience(VIEWER, query(), 'friends');
    expect(page.items.map((i) => i.targetId)).toEqual(['f3', 'f1']);
  });

  it('sorts descending and assigns 1-based ranks within the projection', async () => {
    const page = await service.projectAudience(VIEWER, query(), 'friends');
    expect(page.items[0]).toEqual(expect.objectContaining({ rank: 1, targetId: 'f3', score: 900 }));
    expect(page.items[1]).toEqual(expect.objectContaining({ rank: 2, targetId: 'f1', score: 300 }));
  });

  it('uses the follower set for a following projection', async () => {
    store.scoreMany.mockResolvedValue([50]);
    repo.hydrateTargets.mockResolvedValue([
      { id: 'x1', username: 'x', avatarKey: null, level: 1, vipLevel: 0 },
    ]);
    await service.projectAudience(VIEWER, query(), 'following');
    expect(social.followerIds).toHaveBeenCalledWith('me');
  });

  it('returns an empty page when the audience set is empty', async () => {
    social.friendIds.mockResolvedValue([]);
    const page = await service.projectAudience(VIEWER, query(), 'friends');
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(store.scoreMany).not.toHaveBeenCalled();
  });

  it('refuses a guest — a projection needs a social graph', async () => {
    await expect(
      service.projectAudience({ id: 'g', isGuest: true }, query(), 'friends'),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Implement the leaderboard service**

Create `src/modules/video-rooms/services/video-room-leaderboard.service.ts`:

```ts
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { LeaderboardStore } from 'src/modules/rankings/services/leaderboard-store.service';
import { RankingPeriodResolver } from 'src/modules/rankings/services/ranking-period.resolver';
import { SOCIAL_SERVICE, type ISocialService } from 'src/modules/social/interfaces';
import {
  VIDEO_ROOM_RANKING_NAMESPACE,
  scopeGlobal,
} from '../constants/video-room-ranking.constants';
import { LeaderboardException } from '../exceptions/video-room-ranking.exceptions';
import { VideoRoomRankingRepository } from '../repositories/video-room-ranking.repository';
import type { RankingEntryDto, RankingQuery, RankingViewer } from './video-room-ranking-query.service';

export type RankingAudience = 'friends' | 'following';

/**
 * Friends and Following leaderboards.
 *
 * These are PROJECTIONS, not ladders. The audience id set is fetched from the
 * social graph and scored against an existing ladder with one ZMSCORE — so a
 * friends leaderboard costs nothing on the write path, can never drift from the
 * global ladder it derives from, and needs no keys of its own. Maintaining a
 * per-user friends ZSET would mean fanning every gift out across the sender's
 * entire friend list, which is unbounded work per gift.
 */
@Injectable()
export class VideoRoomLeaderboardService {
  private readonly ns = VIDEO_ROOM_RANKING_NAMESPACE;

  constructor(
    private readonly store: LeaderboardStore,
    private readonly periods: RankingPeriodResolver,
    @Inject(SOCIAL_SERVICE) private readonly social: ISocialService,
    private readonly repo: VideoRoomRankingRepository,
  ) {}

  async projectAudience(
    viewer: RankingViewer,
    query: RankingQuery,
    audience: RankingAudience,
  ): Promise<Paginated<RankingEntryDto>> {
    if (viewer.isGuest) {
      throw new LeaderboardException(
        'guests have no social graph to project a leaderboard onto',
        HttpStatus.FORBIDDEN,
      );
    }

    const memberIds =
      audience === 'friends'
        ? await this.social.friendIds(viewer.id)
        : await this.social.followerIds(viewer.id);

    if (memberIds.length === 0) {
      return buildPaginated([], 0, query.page, query.limit);
    }

    const dateKey = query.dateKey ?? this.periods.dateKeyFor(query.period, new Date());
    const key = this.store.key(
      this.ns,
      query.scope ?? scopeGlobal(),
      query.dimension,
      query.period,
      dateKey,
    );

    const scores = await this.store.scoreMany(key, memberIds);

    // An unscored member is absent from the ladder, not tied at zero — ranking
    // them would put everyone who did nothing above everyone not yet loaded.
    const ranked = memberIds
      .map((id, i) => ({ member: id, score: scores[i] }))
      .filter((e): e is { member: string; score: number } => e.score !== null)
      .sort((a, b) => b.score - a.score);

    const total = ranked.length;
    const start = (query.page - 1) * query.limit;
    const pageSlice = ranked.slice(start, start + query.limit);

    const details = await this.repo.hydrateTargets(
      pageSlice.map((e) => e.member),
      'user',
    );
    const byId = new Map(details.map((d) => [d.id, d]));

    const items: RankingEntryDto[] = pageSlice.map((entry, index) => {
      const detail = byId.get(entry.member);
      return {
        rank: start + index + 1,
        targetId: entry.member,
        username: detail?.username ?? 'Unknown',
        avatarKey: detail?.avatarKey ?? null,
        score: entry.score,
        level: detail?.level ?? 1,
        vipLevel: detail?.vipLevel ?? 0,
      };
    });

    return buildPaginated(items, total, query.page, query.limit);
  }
}
```

Verify the social interface export path before implementing:

```bash
grep -n "SOCIAL_SERVICE" src/modules/social/interfaces/*.ts | head
```

- [ ] **Step 7: Run both suites and lint**

```bash
pnpm test -- src/modules/video-rooms/services/video-room-ranking-query.service.spec.ts src/modules/video-rooms/services/video-room-leaderboard.service.spec.ts
pnpm lint
```

Expected: PASS; lint exit 0.

- [ ] **Step 8: Report and stop.** **Do not commit.**

---

## Task 17: DTOs + Controller

**Files:**
- Create: `src/modules/video-rooms/dto/video-room-ranking.dto.ts`
- Create: `src/modules/video-rooms/controllers/video-rooms-rankings.controller.ts`
- Test: `src/modules/video-rooms/controllers/video-rooms-rankings.controller.spec.ts`

**Interfaces:**
- Consumes: query/leaderboard services (Task 16), constants (Task 6), `CurrentUser`, `ParseUuidPipe`, `AuthenticatedUser`.
- Produces: `QueryRankingDto`, `RankingEntryResponseDto`, `LeaderboardResponseDto`, `SelfRankResponseDto`, `RankingHistoryResponseDto`, `class VideoRoomsRankingsController`.

- [ ] **Step 1: Write the DTOs**

Create `src/modules/video-rooms/dto/video-room-ranking.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { VideoRoomRankingDimension } from '../constants/video-room-ranking.constants';
import {
  VIDEO_ROOM_RANKING_DEFAULT_PAGE_SIZE,
  VIDEO_ROOM_RANKING_MAX_PAGE_SIZE,
} from '../constants/video-room-ranking.constants';

export enum RankingPeriodDto {
  HOURLY = 'hourly',
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  YEARLY = 'yearly',
  ALLTIME = 'alltime',
}

export enum RankingAudienceDto {
  ALL = 'all',
  FRIENDS = 'friends',
  FOLLOWING = 'following',
}

export class QueryRankingDto {
  @ApiPropertyOptional({
    enum: VideoRoomRankingDimension,
    default: VideoRoomRankingDimension.HOSTS,
    description: 'What is being ranked. Ignored by the dimension-specific routes.',
  })
  @IsOptional()
  @IsEnum(VideoRoomRankingDimension)
  dimension: VideoRoomRankingDimension = VideoRoomRankingDimension.HOSTS;

  @ApiPropertyOptional({ enum: RankingPeriodDto, default: RankingPeriodDto.DAILY })
  @IsOptional()
  @IsEnum(RankingPeriodDto)
  period: RankingPeriodDto = RankingPeriodDto.DAILY;

  @ApiPropertyOptional({
    example: '20260722',
    description:
      'Window to read. Omit for the current window. Formats: hourly YYYYMMDDHH, ' +
      'daily YYYYMMDD, weekly YYYYWww, monthly YYYYMM, quarterly YYYYQq, yearly YYYY. ' +
      'Forbidden for guests.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^(\d{4,10}|\d{4}W\d{2}|\d{4}Q[1-4]|alltime)$/, {
    message: 'dateKey is not a recognised period key',
  })
  dateKey?: string;

  @ApiPropertyOptional({ example: 'IN', description: 'ISO-3166 alpha-2. Country routes only.' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, { message: 'country must be an ISO-3166 alpha-2 code' })
  country?: string;

  @ApiPropertyOptional({ description: 'City id. Narrows the ladder to one city.' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({
    enum: RankingAudienceDto,
    default: RankingAudienceDto.ALL,
    description: 'Project onto your friends or followers instead of everyone.',
  })
  @IsOptional()
  @IsEnum(RankingAudienceDto)
  audience: RankingAudienceDto = RankingAudienceDto.ALL;

  @ApiPropertyOptional({ default: VIDEO_ROOM_RANKING_DEFAULT_PAGE_SIZE, maximum: VIDEO_ROOM_RANKING_MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(VIDEO_ROOM_RANKING_MAX_PAGE_SIZE)
  limit: number = VIDEO_ROOM_RANKING_DEFAULT_PAGE_SIZE;

  @ApiPropertyOptional({ default: 1, description: 'Guests may only read page 1.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;
}

export class RankingEntryResponseDto {
  @ApiProperty({ example: 1, description: '1-based, continuous across pages.' })
  rank!: number;

  @ApiProperty({ description: 'User id, or room id on the `rooms` dimension.' })
  targetId!: string;

  @ApiProperty({ example: 'alice' })
  username!: string;

  @ApiProperty({ nullable: true, example: 'avatars/alice.png' })
  avatarKey!: string | null;

  @ApiProperty({ example: 128_400, description: 'Composite score for this dimension.' })
  score!: number;

  @ApiProperty({ example: 12 })
  level!: number;

  @ApiProperty({ example: 3 })
  vipLevel!: number;
}

export class LeaderboardResponseDto {
  @ApiProperty({ type: [RankingEntryResponseDto] })
  items!: RankingEntryResponseDto[];

  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) limit!: number;
  @ApiProperty({ example: 4_812 }) total!: number;
  @ApiProperty({ example: 241 }) totalPages!: number;
}

export class SelfRankResponseDto {
  @ApiProperty({ enum: VideoRoomRankingDimension }) dimension!: string;
  @ApiProperty({ example: 'daily' }) period!: string;
  @ApiProperty({ example: '20260722' }) dateKey!: string;

  @ApiProperty({ nullable: true, example: 482, description: 'Null when unranked.' })
  rank!: number | null;

  @ApiProperty({ example: 9_100 }) score!: number;
}

export class RankingHistoryResponseDto {
  @ApiProperty({ example: '20260721' }) dateKey!: string;
  @ApiProperty({ example: 12 }) rank!: number;
  @ApiProperty({ example: 88_000 }) score!: number;
}
```

- [ ] **Step 2: Write the failing controller test**

Create `src/modules/video-rooms/controllers/video-rooms-rankings.controller.spec.ts`:

```ts
import { VideoRoomRankingDimension } from '../constants/video-room-ranking.constants';
import { QueryRankingDto, RankingAudienceDto, RankingPeriodDto } from '../dto/video-room-ranking.dto';
import { VideoRoomsRankingsController } from './video-rooms-rankings.controller';

const USER = { id: 'u1', roles: [], isGuest: false } as never;
const GUEST = { id: 'g1', roles: [], isGuest: true } as never;

const dto = (over: Partial<QueryRankingDto> = {}): QueryRankingDto =>
  Object.assign(new QueryRankingDto(), {
    dimension: VideoRoomRankingDimension.HOSTS,
    period: RankingPeriodDto.DAILY,
    audience: RankingAudienceDto.ALL,
    limit: 20,
    page: 1,
    ...over,
  });

describe('VideoRoomsRankingsController', () => {
  let query: { getLadder: jest.Mock; getSelfRank: jest.Mock; getHistory: jest.Mock };
  let boards: { projectAudience: jest.Mock };
  let controller: VideoRoomsRankingsController;

  beforeEach(() => {
    query = {
      getLadder: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20, totalPages: 1 }),
      getSelfRank: jest.fn().mockResolvedValue({ rank: 5 }),
      getHistory: jest.fn().mockResolvedValue([]),
    };
    boards = { projectAudience: jest.fn().mockResolvedValue({ items: [] }) };
    controller = new VideoRoomsRankingsController(query as never, boards as never);
  });

  it('forces the dimension on each dimension-specific route', async () => {
    await controller.hosts(USER, dto({ dimension: VideoRoomRankingDimension.PK }));
    expect(query.getLadder.mock.calls[0][1].dimension).toBe(VideoRoomRankingDimension.HOSTS);

    await controller.gifters(USER, dto());
    expect(query.getLadder.mock.calls[1][1].dimension).toBe(VideoRoomRankingDimension.GIFTERS);

    await controller.rooms(USER, dto());
    expect(query.getLadder.mock.calls[2][1].dimension).toBe(VideoRoomRankingDimension.ROOMS);
  });

  it('passes the caller through as a viewer with the guest flag intact', async () => {
    await controller.hosts(GUEST, dto());
    expect(query.getLadder.mock.calls[0][0]).toEqual({ id: 'g1', isGuest: true });
  });

  it('treats a missing isGuest flag as not-a-guest', async () => {
    await controller.hosts({ id: 'u2', roles: [] } as never, dto());
    expect(query.getLadder.mock.calls[0][0].isGuest).toBe(false);
  });

  it('routes an audience projection to the leaderboard service, not the ladder', async () => {
    await controller.gifters(USER, dto({ audience: RankingAudienceDto.FRIENDS }));
    expect(boards.projectAudience).toHaveBeenCalledWith(
      { id: 'u1', isGuest: false },
      expect.objectContaining({ dimension: VideoRoomRankingDimension.GIFTERS }),
      'friends',
    );
    expect(query.getLadder).not.toHaveBeenCalled();
  });

  it('builds a country scope from the query parameter', async () => {
    await controller.country(USER, dto({ country: 'in' }));
    expect(query.getLadder.mock.calls[0][1].scope).toBe('c:IN');
  });

  it('builds a room scope from the path parameter', async () => {
    await controller.roomLadder(USER, 'room-1', dto());
    expect(query.getLadder.mock.calls[0][1].scope).toBe('r:room-1');
  });

  it('prefers city over country when both are supplied', async () => {
    await controller.country(USER, dto({ country: 'IN', city: 'city-9' }));
    expect(query.getLadder.mock.calls[0][1].scope).toBe('y:city-9');
  });
});
```

- [ ] **Step 3: Implement the controller**

Create `src/modules/video-rooms/controllers/video-rooms-rankings.controller.ts`:

```ts
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  VideoRoomRankingDimension,
  scopeCity,
  scopeCountry,
  scopeGlobal,
  scopeRoom,
} from '../constants/video-room-ranking.constants';
import {
  LeaderboardResponseDto,
  QueryRankingDto,
  RankingAudienceDto,
  RankingHistoryResponseDto,
  SelfRankResponseDto,
} from '../dto/video-room-ranking.dto';
import { VideoRoomLeaderboardService } from '../services/video-room-leaderboard.service';
import type { RankingQuery, RankingViewer } from '../services/video-room-ranking-query.service';
import { VideoRoomRankingQueryService } from '../services/video-room-ranking-query.service';

/**
 * VR-13 ranking REST surface (base `video-rooms/rankings`).
 *
 * Every route is a read. Rankings are never mutated over HTTP — they move only
 * in response to domain events and aggregation jobs, which is what keeps the
 * ladder a derived projection rather than something a client can push.
 *
 * The path prefix is `video-rooms` (plural), matching every shipped video-room
 * controller. The phase brief writes `/video-room/rankings/...` singular;
 * consistency with the deployed surface wins.
 *
 * Authorization — including the guest limit — lives in
 * `VideoRoomRankingQueryService`, never inline here. This is the VR-10/11/12
 * controller convention.
 */
@ApiTags('video-room-rankings')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomsRankingsController {
  constructor(
    private readonly query: VideoRoomRankingQueryService,
    private readonly boards: VideoRoomLeaderboardService,
  ) {}

  /** `isGuest` is optional on the token claim; absent means a full account. */
  private viewer(user: AuthenticatedUser): RankingViewer {
    return { id: user.id, isGuest: user.isGuest === true };
  }

  private toQuery(
    dto: QueryRankingDto,
    dimension: VideoRoomRankingDimension,
    scope: string,
  ): RankingQuery {
    return {
      dimension,
      period: dto.period,
      dateKey: dto.dateKey,
      scope,
      limit: dto.limit,
      page: dto.page,
    };
  }

  /** Ladder read, or a friends/following projection when one is requested. */
  private read(
    user: AuthenticatedUser,
    dto: QueryRankingDto,
    dimension: VideoRoomRankingDimension,
    scope: string = scopeGlobal(),
  ) {
    const viewer = this.viewer(user);
    const query = this.toQuery(dto, dimension, scope);
    if (dto.audience === RankingAudienceDto.FRIENDS) {
      return this.boards.projectAudience(viewer, query, 'friends');
    }
    if (dto.audience === RankingAudienceDto.FOLLOWING) {
      return this.boards.projectAudience(viewer, query, 'following');
    }
    return this.query.getLadder(viewer, query);
  }

  private geoScope(dto: QueryRankingDto): string {
    // City is the narrower of the two; when both arrive it is what was meant.
    if (dto.city) return scopeCity(dto.city);
    if (dto.country) return scopeCountry(dto.country);
    return scopeGlobal();
  }

  @Get('rankings/global')
  @ApiOperation({
    summary: 'Global leaderboard for any dimension',
    description:
      'The global-scope entry point. `dimension` selects the ladder (default `hosts`); ' +
      'this is not a separate ranking. Guests receive the top 10 only, without ' +
      'pagination or historical windows.',
  })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'VIDEO_ROOM_RANKING_PERIOD_INVALID — dateKey does not parse for the period; or ' +
      'VIDEO_ROOM_RANKING_INVALID — unknown dimension',
  })
  @ApiResponse({
    status: 403,
    description:
      'VIDEO_ROOM_RANKING_INVALID — a guest requested page > 1, a historical dateKey, or a projection',
  })
  global(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, dto.dimension);
  }

  @Get('rankings/hosts')
  @ApiOperation({
    summary: 'Top hosts',
    description:
      'Composite of coins received, gift count, watch time, peak viewers, PK wins and ' +
      'treasure events while holding a seat. Weights are config-driven.',
  })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  @ApiResponse({ status: 400, description: 'VIDEO_ROOM_RANKING_PERIOD_INVALID' })
  @ApiResponse({ status: 403, description: 'guest limit exceeded' })
  hosts(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, VideoRoomRankingDimension.HOSTS);
  }

  @Get('rankings/gifters')
  @ApiOperation({
    summary: 'Top gifters',
    description:
      'Coins spent in video rooms. Distinct from GET /rankings/gifters, which is the ' +
      'platform-wide ladder across every context.',
  })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  @ApiResponse({ status: 400, description: 'VIDEO_ROOM_RANKING_PERIOD_INVALID' })
  gifters(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, VideoRoomRankingDimension.GIFTERS);
  }

  @Get('rankings/receivers')
  @ApiOperation({ summary: 'Top receivers', description: 'Coins received in video rooms.' })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  receivers(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, VideoRoomRankingDimension.RECEIVERS);
  }

  @Get('rankings/rooms')
  @ApiOperation({
    summary: 'Top rooms',
    description:
      'Engagement composite: gift revenue, peak viewers, average watch time, PK battles ' +
      'and treasure activity. Entries are rooms — `targetId` is a room id.',
  })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  rooms(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, VideoRoomRankingDimension.ROOMS);
  }

  @Get('rankings/pk')
  @ApiOperation({
    summary: 'PK leaderboard',
    description: 'Wins weighted heavily over raw battle score. Draws count as neither.',
  })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  pk(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, VideoRoomRankingDimension.PK);
  }

  @Get('rankings/treasure')
  @ApiOperation({ summary: 'Treasure winners', description: 'Coins won from treasure boxes.' })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  treasure(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, VideoRoomRankingDimension.TREASURE);
  }

  @Get('rankings/vip')
  @ApiOperation({
    summary: 'VIP leaderboard',
    description: 'Ordered by VIP level; coins spent breaks ties within a level only.',
  })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  vip(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, VideoRoomRankingDimension.VIP);
  }

  @Get('rankings/country')
  @ApiOperation({
    summary: 'Country or city leaderboard',
    description:
      'Ranks users WITHIN a geography — "top hosts in India this week". Pass `country` ' +
      '(ISO-3166 alpha-2) or `city`; `city` wins when both are given. Countries are ' +
      'not ranked against one another.',
  })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  @ApiResponse({ status: 400, description: 'country must be an ISO-3166 alpha-2 code' })
  country(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, dto.dimension, this.geoScope(dto));
  }

  @Get('rankings/me')
  @ApiOperation({
    summary: 'Your own position',
    description: 'Your 1-based rank and score. `rank` is null when you are unranked.',
  })
  @ApiResponse({ status: 200, type: SelfRankResponseDto })
  @ApiResponse({ status: 403, description: 'guests have no ranking position' })
  me(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.query.getSelfRank(this.viewer(user), dto.dimension, dto.period, this.geoScope(dto));
  }

  @Get('rankings/history')
  @ApiOperation({
    summary: 'Historical positions for one entity',
    description:
      'Snapshot-backed. Returns the most recent windows first for the given dimension ' +
      'and period. Not available to guests.',
  })
  @ApiResponse({ status: 200, type: [RankingHistoryResponseDto] })
  @ApiResponse({ status: 403, description: 'guests may not read ranking history' })
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: QueryRankingDto,
    @Query('targetId') targetId?: string,
  ) {
    return this.query.getHistory(
      this.viewer(user),
      targetId ?? user.id,
      dto.dimension,
      dto.period,
      dto.limit,
    );
  }

  @Get(':id/rankings')
  @ApiOperation({
    summary: 'Leaderboard scoped to one room',
    description:
      'The same dimensions, restricted to activity in this room — "top supporters in ' +
      'this room today". Room ladders carry a TTL, so a long-closed room returns empty.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  @ApiResponse({ status: 400, description: 'VIDEO_ROOM_RANKING_PERIOD_INVALID' })
  roomLadder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Query() dto: QueryRankingDto,
  ) {
    return this.read(user, dto, dto.dimension, scopeRoom(roomId));
  }
}
```

- [ ] **Step 4: Run the test and lint**

```bash
pnpm test -- src/modules/video-rooms/controllers/video-rooms-rankings.controller.spec.ts
pnpm lint
```

Expected: PASS; lint exit 0.

- [ ] **Step 5: Report and stop.** **Do not commit.**

---

## Task 18: Socket, metrics, and audit listeners

**Files:**
- Create: `src/modules/video-rooms/listeners/video-room-ranking-socket.listener.ts` + `.spec.ts`
- Create: `src/modules/video-rooms/listeners/video-room-ranking-metrics.listener.ts` + `.spec.ts`
- Create: `src/modules/video-rooms/listeners/video-room-ranking-audit.listener.ts` + `.spec.ts`
- Modify: `src/modules/video-rooms/video-rooms.metrics.ts`

**Interfaces:**
- Consumes: `EVENT_BUS`, `SocketManager`, `VIDEO_ROOM_NAMESPACE`, ranking events (Task 10), `VideoRoomEventsRepository`, `VideoRoomsMetrics`, `LeaderboardCache`.
- Produces: three listener classes; `VideoRoomsMetrics` gains `observeRankingUpdate`, `observeRankingAggregation`, `observeRankingSnapshot`, `observeRankingApi`, `incRankingUpdate`, `incRankingCache`, `incRankingBroadcast`, `setRankingLadderSize`.

- [ ] **Step 1: Write the failing socket-listener test**

Create `src/modules/video-rooms/listeners/video-room-ranking-socket.listener.spec.ts`:

```ts
import { VIDEO_ROOM_RANKING_SOCKET_EVENTS } from '../constants/video-room-ranking.constants';
import { VIDEO_ROOM_RANKING_EVENTS } from '../events/video-room-ranking.events';
import { VideoRoomRankingSocketListener } from './video-room-ranking-socket.listener';

jest.useFakeTimers();

describe('VideoRoomRankingSocketListener', () => {
  let handlers: Record<string, (e: unknown) => void>;
  let bus: { subscribe: jest.Mock };
  let sockets: { emitToNamespaceRoom: jest.Mock };
  let listener: VideoRoomRankingSocketListener;

  const event = (roomId = 'room-1', dimension = 'hosts') => ({
    payload: { scope: `r:${roomId}`, dimension, period: 'daily', dateKey: '20260722', roomId, entries: [] },
  });

  beforeEach(() => {
    handlers = {};
    bus = {
      subscribe: jest.fn((name: string, h: (e: unknown) => void) => {
        handlers[name] = h;
        return () => undefined;
      }),
    };
    sockets = { emitToNamespaceRoom: jest.fn() };
    listener = new VideoRoomRankingSocketListener(
      { get: () => ({}) } as never,
      bus as never,
      sockets as never,
    );
    listener.onModuleInit();
  });

  afterEach(() => {
    jest.clearAllTimers();
    listener.onModuleDestroy();
  });

  it('subscribes to every movement event', () => {
    expect(handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED]).toBeDefined();
    expect(handlers[VIDEO_ROOM_RANKING_EVENTS.PK_RANKING_UPDATED]).toBeDefined();
    expect(handlers[VIDEO_ROOM_RANKING_EVENTS.TREASURE_RANKING_UPDATED]).toBeDefined();
  });

  it('does not emit synchronously — the window must elapse first', () => {
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event());
    expect(sockets.emitToNamespaceRoom).not.toHaveBeenCalled();
  });

  it('emits once after the window closes', () => {
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event());
    jest.advanceTimersByTime(1_000);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledTimes(1);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'room-1',
      VIDEO_ROOM_RANKING_SOCKET_EVENTS.HOST_RANK_UPDATED,
      expect.objectContaining({ dimension: 'hosts' }),
    );
  });

  it('collapses a burst on one dimension into a single broadcast', () => {
    for (let i = 0; i < 50; i += 1) {
      handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event());
    }
    jest.advanceTimersByTime(1_000);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledTimes(1);
  });

  it('keeps different dimensions in the same room separate', () => {
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event('room-1', 'hosts'));
    handlers[VIDEO_ROOM_RANKING_EVENTS.GIFTER_RANKING_UPDATED](event('room-1', 'gifters'));
    jest.advanceTimersByTime(1_000);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledTimes(2);
  });

  it('keeps different rooms separate', () => {
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event('room-1'));
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event('room-2'));
    jest.advanceTimersByTime(1_000);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh window after one flushes', () => {
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event());
    jest.advanceTimersByTime(1_000);
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event());
    jest.advanceTimersByTime(1_000);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledTimes(2);
  });

  it('ignores an event with no roomId — there is nowhere to send it', () => {
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED]({
      payload: { scope: 'g', dimension: 'hosts', period: 'daily', dateKey: '20260722', entries: [] },
    });
    jest.advanceTimersByTime(1_000);
    expect(sockets.emitToNamespaceRoom).not.toHaveBeenCalled();
  });

  it('swallows an emit failure rather than poisoning the timer loop', () => {
    sockets.emitToNamespaceRoom.mockImplementation(() => {
      throw new Error('socket gone');
    });
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event());
    expect(() => jest.advanceTimersByTime(1_000)).not.toThrow();
  });
});
```

- [ ] **Step 2: Implement the socket listener**

Create `src/modules/video-rooms/listeners/video-room-ranking-socket.listener.ts`:

```ts
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { loadVideoRoomRankingConfig } from '../config/video-room-ranking.config';
import {
  DIMENSION_SOCKET_EVENT,
  VideoRoomRankingDimension,
  VIDEO_ROOM_RANKING_SOCKET_EVENTS,
} from '../constants/video-room-ranking.constants';
import { VIDEO_ROOM_NAMESPACE } from '../constants/video-room.constants';
import {
  VIDEO_ROOM_RANKING_EVENTS,
  type RankingMovementPayload,
} from '../events/video-room-ranking.events';

/** The most recent payload seen for one (room, dimension) inside a window. */
interface PendingBroadcast {
  event: string;
  payload: RankingMovementPayload;
}

/**
 * Bridges ranking movement to `/video-room` sockets — COALESCED.
 *
 * This is the one VR socket listener that must throttle. The treasure listener
 * deliberately does not, because its upstream already coalesces; ranking has no
 * such upstream. A single gift moves up to four dimensions, and a gift storm in
 * a busy room produces hundreds of movements a second. Emitting each one would
 * flood every client in the room with frames they cannot render, for a ladder
 * that visibly changes a few times a second at most.
 *
 * Only the LATEST payload per (room, dimension) survives a window — an
 * intermediate ranking state has no value once a newer one exists.
 */
@Injectable()
export class VideoRoomRankingSocketListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoRoomRankingSocketListener.name);
  private readonly windowMs: number;
  private readonly pending = new Map<string, PendingBroadcast>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    config: ConfigService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {
    this.windowMs = loadVideoRoomRankingConfig(config).coalesceWindowMs;
  }

  onModuleInit(): void {
    const subscribe = (busName: string, socketEvent: string) =>
      this.bus.subscribe<{ payload: RankingMovementPayload }>(busName, (e) =>
        this.enqueue(socketEvent, e.payload),
      );

    subscribe(VIDEO_ROOM_RANKING_EVENTS.RANKING_UPDATED, VIDEO_ROOM_RANKING_SOCKET_EVENTS.RANKING_UPDATED);
    subscribe(
      VIDEO_ROOM_RANKING_EVENTS.LEADERBOARD_UPDATED,
      VIDEO_ROOM_RANKING_SOCKET_EVENTS.LEADERBOARD_UPDATED,
    );
    subscribe(
      VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED,
      DIMENSION_SOCKET_EVENT[VideoRoomRankingDimension.HOSTS],
    );
    subscribe(
      VIDEO_ROOM_RANKING_EVENTS.GIFTER_RANKING_UPDATED,
      DIMENSION_SOCKET_EVENT[VideoRoomRankingDimension.GIFTERS],
    );
    subscribe(
      VIDEO_ROOM_RANKING_EVENTS.ROOM_RANKING_UPDATED,
      DIMENSION_SOCKET_EVENT[VideoRoomRankingDimension.ROOMS],
    );
    subscribe(
      VIDEO_ROOM_RANKING_EVENTS.PK_RANKING_UPDATED,
      DIMENSION_SOCKET_EVENT[VideoRoomRankingDimension.PK],
    );
    subscribe(
      VIDEO_ROOM_RANKING_EVENTS.TREASURE_RANKING_UPDATED,
      DIMENSION_SOCKET_EVENT[VideoRoomRankingDimension.TREASURE],
    );
  }

  /** Clear timers so a shutdown or a test teardown leaves nothing pending. */
  onModuleDestroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }

  private enqueue(socketEvent: string, payload: RankingMovementPayload): void {
    // A global-scope movement has no room to broadcast into. Clients read those
    // over REST; pushing them would mean fanning out to every connected socket.
    if (!payload.roomId) return;

    const slot = `${payload.roomId}:${payload.dimension}`;
    this.pending.set(slot, { event: socketEvent, payload });

    if (this.timers.has(slot)) return; // window already open

    this.timers.set(
      slot,
      setTimeout(() => this.flush(slot), this.windowMs),
    );
  }

  private flush(slot: string): void {
    this.timers.delete(slot);
    const entry = this.pending.get(slot);
    this.pending.delete(slot);
    if (!entry) return;

    try {
      this.sockets.emitToNamespaceRoom(
        VIDEO_ROOM_NAMESPACE,
        entry.payload.roomId as string,
        entry.event,
        entry.payload,
      );
    } catch (err) {
      // Swallowed: this runs on a timer with no caller to receive a throw, and
      // an unhandled rejection here would take down the process.
      this.logger.warn(`ranking broadcast failed for ${slot}: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 3: Add the metrics families**

In `src/modules/video-rooms/video-rooms.metrics.ts`, declare the fields alongside the existing ones:

```ts
  // ---- VR-13 rankings ----
  private readonly rankingUpdateLatency: Histogram;
  private readonly rankingUpdates: Counter<'dimension'>;
  private readonly rankingDedupeSkips: Counter;
  private readonly rankingCacheHits: Counter;
  private readonly rankingCacheMisses: Counter;
  private readonly rankingAggregationDuration: Histogram<'period'>;
  private readonly rankingSnapshotDuration: Histogram<'period'>;
  private readonly rankingApiLatency: Histogram<'dimension'>;
  private readonly rankingBroadcasts: Counter;
  private readonly rankingLadderSize: Gauge<'dimension'>;
```

Register them in the constructor following the file's existing registration style (same `MetricsService` registry, `video_room_` name prefix), then add the helpers:

```ts
  observeRankingUpdate(seconds: number): void {
    this.rankingUpdateLatency.observe(seconds);
  }

  incRankingUpdate(dimension: string, count = 1): void {
    this.rankingUpdates.inc({ dimension }, count);
  }

  incRankingDedupeSkip(): void {
    this.rankingDedupeSkips.inc();
  }

  /** Drained from LeaderboardCache.snapshotCounters() by the metrics listener. */
  incRankingCache(hits: number, misses: number): void {
    if (hits > 0) this.rankingCacheHits.inc(hits);
    if (misses > 0) this.rankingCacheMisses.inc(misses);
  }

  observeRankingAggregation(period: string, seconds: number): void {
    this.rankingAggregationDuration.observe({ period }, seconds);
  }

  observeRankingSnapshot(period: string, seconds: number): void {
    this.rankingSnapshotDuration.observe({ period }, seconds);
  }

  observeRankingApi(dimension: string, seconds: number): void {
    this.rankingApiLatency.observe({ dimension }, seconds);
  }

  incRankingBroadcast(count = 1): void {
    this.rankingBroadcasts.inc(count);
  }

  setRankingLadderSize(dimension: string, size: number): void {
    this.rankingLadderSize.set({ dimension }, size);
  }
```

- [ ] **Step 3b: Wire `observeRankingApi` — it has no caller yet**

Every other ranking metric is fed by an event the metrics listener subscribes
to. API latency is the exception: there is no event for "a request was served",
so a declared-but-uncalled `rankingApiLatency` would report zero forever, which
is worse than not having it — a flat green panel implies a healthy read path
rather than an unmeasured one.

Inject `VideoRoomsMetrics` into `VideoRoomRankingQueryService` (Task 16) and
time the read. Add to its constructor:

```ts
    private readonly metrics: VideoRoomsMetrics,
```

and wrap the body of `getLadder` so every exit path records, including the
cache-hit fast path (which is precisely the latency you want to see fall):

```ts
  async getLadder(viewer: RankingViewer, query: RankingQuery): Promise<Paginated<RankingEntryDto>> {
    const startedAt = Date.now();
    try {
      return await this.readLadder(viewer, query);
    } finally {
      // `finally`, so a rejected read still reports its latency. A p99 computed
      // only from successful requests hides exactly the slow failures — a
      // timing-out Redis read — that the panel exists to surface.
      this.metrics.observeRankingApi(query.dimension, (Date.now() - startedAt) / 1000);
    }
  }
```

Rename the existing implementation body to `private async readLadder(...)` with
the identical signature. The Task 16 spec is unchanged by this — it asserts
behaviour, not timing — but add one case to it:

```ts
    it('records API latency even when the read throws', async () => {
      store.range.mockRejectedValue(new Error('down'));
      repo.findLeaderboardSnapshot.mockRejectedValue(new Error('also down'));
      await expect(service.getLadder(MEMBER, query())).rejects.toThrow();
      expect(metrics.observeRankingApi).toHaveBeenCalledWith('hosts', expect.any(Number));
    });
```

and add `metrics` to that spec's constructor mocks:

```ts
    const metrics = { observeRankingApi: jest.fn() };
```

- [ ] **Step 4: Write and implement the metrics listener**

Create `src/modules/video-rooms/listeners/video-room-ranking-metrics.listener.ts`:

```ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { LeaderboardCache } from 'src/modules/rankings/services/leaderboard-cache.service';
import {
  VIDEO_ROOM_RANKING_EVENTS,
  type RankingAggregatedEvent,
  type RankingMovementPayload,
  type RankingSnapshotCreatedEvent,
} from '../events/video-room-ranking.events';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/**
 * Prometheus fan-out for VR-13, on the shared VideoRoomsMetrics registry.
 *
 * Cache hit rate is DRAINED rather than observed per read: LeaderboardCache
 * counts in-process and this listener transfers the totals on each aggregation
 * tick. Incrementing a Prometheus counter inside the read path would add work
 * to the very requests the cache exists to make fast.
 */
@Injectable()
export class VideoRoomRankingMetricsListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly metrics: VideoRoomsMetrics,
    private readonly cache: LeaderboardCache,
  ) {}

  onModuleInit(): void {
    for (const name of [
      VIDEO_ROOM_RANKING_EVENTS.RANKING_UPDATED,
      VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED,
      VIDEO_ROOM_RANKING_EVENTS.GIFTER_RANKING_UPDATED,
      VIDEO_ROOM_RANKING_EVENTS.ROOM_RANKING_UPDATED,
      VIDEO_ROOM_RANKING_EVENTS.PK_RANKING_UPDATED,
      VIDEO_ROOM_RANKING_EVENTS.TREASURE_RANKING_UPDATED,
    ]) {
      this.bus.subscribe<{ payload: RankingMovementPayload }>(name, (e) => {
        this.metrics.incRankingUpdate(e.payload.dimension);
      });
    }

    this.bus.subscribe<RankingAggregatedEvent>(VIDEO_ROOM_RANKING_EVENTS.AGGREGATED, (e) => {
      this.metrics.observeRankingAggregation(e.payload.period, e.payload.durationMs / 1000);
      this.metrics.setRankingLadderSize(e.payload.dimension, e.payload.entriesWritten);
      const { hits, misses } = this.cache.snapshotCounters();
      this.metrics.incRankingCache(hits, misses);
    });

    this.bus.subscribe<RankingSnapshotCreatedEvent>(
      VIDEO_ROOM_RANKING_EVENTS.SNAPSHOT_CREATED,
      (e) => this.metrics.observeRankingSnapshot(e.payload.period, e.payload.durationMs / 1000),
    );
  }
}
```

Its spec should assert: every movement event increments `incRankingUpdate` with the right dimension label; an aggregated event observes duration in **seconds** (not ms) and drains the cache counters; a snapshot event observes snapshot duration.

- [ ] **Step 5: Write and implement the audit listener**

Create `src/modules/video-rooms/listeners/video-room-ranking-audit.listener.ts`:

```ts
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EVENT_BUS, type DomainEvent, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_SYSTEM_ACTOR_ID } from '../constants/video-room.constants';
import { VIDEO_ROOM_RANKING_EVENTS } from '../events/video-room-ranking.events';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';

/** Bus event name → the `VideoRoomEvent.eventType` written for it. */
const AUDITED: Record<string, string> = {
  [VIDEO_ROOM_RANKING_EVENTS.RANKING_UPDATED]: 'ranking.updated',
  [VIDEO_ROOM_RANKING_EVENTS.LEADERBOARD_UPDATED]: 'ranking.leaderboard_changed',
  [VIDEO_ROOM_RANKING_EVENTS.AGGREGATED]: 'ranking.aggregated',
  [VIDEO_ROOM_RANKING_EVENTS.SNAPSHOT_CREATED]: 'ranking.snapshot_created',
};

/**
 * Writes the ranking audit trail into the existing append-only VideoRoomEvent
 * store — no new log table, mirroring VideoRoomTreasureAuditListener.
 *
 * Only the four LIFECYCLE events are audited, deliberately. The per-dimension
 * movement events fire on every gift; auditing those would write a row per gift
 * per dimension, duplicating gift_transactions at four times its volume and
 * burying the aggregation history an auditor actually reads.
 *
 * Failures are swallowed. Audit is observational, and throwing would poison the
 * bus for the socket bridge and the metrics listener.
 */
@Injectable()
export class VideoRoomRankingAuditListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomRankingAuditListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly events: VideoRoomEventsRepository,
  ) {}

  onModuleInit(): void {
    for (const [busName, eventType] of Object.entries(AUDITED)) {
      this.bus.subscribe<DomainEvent<Record<string, unknown>>>(busName, (e) =>
        this.append(eventType, e.payload, e.eventId),
      );
    }
  }

  private async append(
    eventType: string,
    payload: Record<string, unknown>,
    eventId: string,
  ): Promise<void> {
    try {
      const { roomId, scope, dimension, period, dateKey, requestId, ...rest } = payload;

      // A global-scope ranking event has no room. VideoRoomEvent.roomId is
      // required, so those are dropped rather than written against a fake room.
      if (!roomId) return;

      await this.events.appendEvent({
        roomId: roomId as string,
        eventType,
        // The ladder coordinates are what an auditor traces by.
        referenceId: `${scope as string}:${dimension as string}:${period as string}:${dateKey as string}`,
        correlationId: eventId,
        // Rankings move on their own; no human is the actor.
        actorId: VIDEO_ROOM_SYSTEM_ACTOR_ID,
        payload: {
          scope,
          dimension,
          period,
          dateKey,
          requestId: requestId ?? null,
          ...rest,
        } as Prisma.InputJsonValue,
      });
    } catch (err) {
      this.logger.warn(`ranking audit append failed (${eventType}): ${(err as Error).message}`);
    }
  }
}
```

Its spec should assert: only the four lifecycle names are subscribed (movement events are **not**); a payload without `roomId` writes nothing; `referenceId` is the composed ladder coordinate; an `appendEvent` rejection does not throw.

- [ ] **Step 6: Run all three listener suites and lint**

```bash
pnpm test -- src/modules/video-rooms/listeners/video-room-ranking-socket.listener.spec.ts src/modules/video-rooms/listeners/video-room-ranking-metrics.listener.spec.ts src/modules/video-rooms/listeners/video-room-ranking-audit.listener.spec.ts src/modules/video-rooms/video-rooms.metrics.spec.ts
pnpm lint
```

Expected: PASS; lint exit 0. `video-rooms.metrics.spec.ts` must still pass — the metrics additions are additive.

- [ ] **Step 7: Report and stop.** **Do not commit.**

---

## Task 19: Module wiring + integration test

**Files:**
- Modify: `src/modules/video-rooms/video-rooms.module.ts`
- Create: `src/modules/video-rooms/video-rooms-ranking.integration.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–18.
- Produces: a wired, bootable module.

- [ ] **Step 1: Wire the module**

In `src/modules/video-rooms/video-rooms.module.ts`, add `VideoRoomsRankingsController` to `controllers`, and append to `providers`:

```ts
    // ---- VR-13 ranking & leaderboard engine ----
    // The generic ranking CORE (RankingPeriodResolver / LeaderboardStore /
    // LeaderboardCache) is injected from RankingsModule, which exports it.
    // RankingsModule is NOT @Global, so it is imported below — this is the only
    // cross-module import VideoRoomsModule needs for VR-13.
    VideoRoomRankingRepository,
    VideoRoomRankingScoreEngine,
    VideoRoomRankingScopeResolver,
    VideoRoomRankingService,
    VideoRoomRankingQueryService,
    VideoRoomLeaderboardService,
    VideoRoomRankingAggregationService,
    VideoRoomRankingSnapshotService,
    VideoRoomRankingRecoveryService,
    VideoRoomRankingJobsService,
    VideoRoomRankingScheduler,
    VideoRoomRankingActivityListener,
    VideoRoomRankingSocketListener,
    VideoRoomRankingMetricsListener,
    VideoRoomRankingAuditListener,
```

and add `RankingsModule` to `imports`:

```ts
  imports: [
    BullModule.registerQueue({ name: VIDEO_ROOM_QUEUES.MAIN }, { name: VIDEO_ROOM_QUEUES.CLEANUP }),
    // VR-13 consumes the generic ranking core (period resolver, ZSET store,
    // page cache) that RankingsModule exports. Importing it does NOT make this
    // module write `rankings:*` keys — VR-13 uses the `vrank` namespace
    // exclusively, so the platform ladders are untouched.
    RankingsModule,
  ],
```

Verify no circular import results:

```bash
pnpm boundaries
```

If `RankingsModule` importing anything from `video-rooms` creates a cycle, resolve it by moving the three core services into their own `RankingCoreModule` inside `src/modules/rankings/` and importing that instead.

- [ ] **Step 2: Write the integration test**

Create `src/modules/video-rooms/video-rooms-ranking.integration.spec.ts`, wiring the real `LeaderboardStore`, `RankingPeriodResolver`, `VideoRoomRankingScoreEngine`, `VideoRoomRankingService` and `VideoRoomRankingQueryService` against an in-memory Redis double, and asserting the full path:

```ts
import { LeaderboardCache } from 'src/modules/rankings/services/leaderboard-cache.service';
import { LeaderboardStore } from 'src/modules/rankings/services/leaderboard-store.service';
import { RankingPeriodResolver } from 'src/modules/rankings/services/ranking-period.resolver';
import { VideoRoomRankingDimension } from './constants/video-room-ranking.constants';
import { VideoRoomRankingQueryService } from './services/video-room-ranking-query.service';
import { VideoRoomRankingScoreEngine } from './services/video-room-ranking-score.engine';
import { VideoRoomRankingService } from './services/video-room-ranking.service';

/** Minimal in-memory ZSET + string store covering the commands VR-13 issues. */
class FakeRedis {
  private zsets = new Map<string, Map<string, number>>();
  private strings = new Map<string, string>();

  private z(key: string): Map<string, number> {
    if (!this.zsets.has(key)) this.zsets.set(key, new Map());
    return this.zsets.get(key) as Map<string, number>;
  }

  zincrby(key: string, delta: number, member: string): Promise<string> {
    const z = this.z(key);
    const next = (z.get(member) ?? 0) + Number(delta);
    z.set(member, next);
    return Promise.resolve(String(next));
  }

  private sorted(key: string): [string, number][] {
    return [...this.z(key).entries()].sort((a, b) => b[1] - a[1]);
  }

  zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    const slice = this.sorted(key).slice(start, stop === -1 ? undefined : stop + 1);
    return Promise.resolve(slice.flatMap(([m, s]) => [m, String(s)]));
  }

  zcard(key: string): Promise<number> {
    return Promise.resolve(this.z(key).size);
  }

  zrevrank(key: string, member: string): Promise<number | null> {
    const i = this.sorted(key).findIndex(([m]) => m === member);
    return Promise.resolve(i === -1 ? null : i);
  }

  zscore(key: string, member: string): Promise<string | null> {
    const s = this.z(key).get(member);
    return Promise.resolve(s === undefined ? null : String(s));
  }

  set(key: string, value: string, ..._rest: unknown[]): Promise<string | null> {
    if (this.strings.has(key)) return Promise.resolve(null); // NX semantics
    this.strings.set(key, value);
    return Promise.resolve('OK');
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.strings.get(key) ?? null);
  }

  incr(key: string): Promise<number> {
    const next = Number(this.strings.get(key) ?? 0) + 1;
    this.strings.set(key, String(next));
    return Promise.resolve(next);
  }

  expire(): Promise<number> {
    return Promise.resolve(1);
  }

  pipeline() {
    const ops: (() => Promise<unknown>)[] = [];
    const chain = {
      zincrby: (k: string, d: number, m: string) => {
        ops.push(() => this.zincrby(k, d, m));
        return chain;
      },
      expire: () => chain,
      zadd: () => chain,
      exec: async () => {
        for (const op of ops) await op();
        return [];
      },
    };
    return chain;
  }
}

describe('VR-13 ranking engine (integration)', () => {
  const config = { get: () => ({}) } as never;
  const AT = new Date('2026-07-22T14:35:00.000Z');
  let redis: FakeRedis;
  let store: LeaderboardStore;
  let writes: VideoRoomRankingService;
  let reads: VideoRoomRankingQueryService;

  const gift = (over = {}) => ({
    transactionId: 'txn-1',
    roomId: 'room-1',
    senderId: 'whale',
    receiverId: 'host',
    totalCoinValue: 1_000,
    quantity: 1,
    receiverIsSeated: true,
    occurredAt: AT,
    ...over,
  });

  beforeEach(() => {
    redis = new FakeRedis();
    store = new LeaderboardStore(redis as never);
    const periods = new RankingPeriodResolver();
    const scoring = new VideoRoomRankingScoreEngine(config);

    writes = new VideoRoomRankingService(
      config,
      store,
      periods,
      scoring,
      { scopesFor: () => Promise.resolve(['g', 'r:room-1']) } as never,
      { publish: () => Promise.resolve() } as never,
    );

    reads = new VideoRoomRankingQueryService(
      config,
      store,
      new LeaderboardCache(
        { get: () => Promise.resolve(null), set: () => Promise.resolve() } as never,
        store,
      ),
      periods,
      {
        hydrateTargets: (ids: string[]) =>
          Promise.resolve(
            ids.map((id) => ({ id, username: id, avatarKey: null, level: 1, vipLevel: 0 })),
          ),
      } as never,
    );
  });

  const viewer = { id: 'whale', isGuest: false };
  const query = (dimension: VideoRoomRankingDimension) => ({
    dimension,
    period: 'daily' as const,
    limit: 20,
    page: 1,
  });

  it('moves a gift all the way from write to a readable ladder', async () => {
    await writes.recordGift(gift());
    const page = await reads.getLadder(viewer, query(VideoRoomRankingDimension.GIFTERS));
    expect(page.items).toEqual([
      expect.objectContaining({ rank: 1, targetId: 'whale', score: 1_000 }),
    ]);
  });

  it('ranks a bigger spender above a smaller one', async () => {
    await writes.recordGift(gift({ transactionId: 't1', senderId: 'whale', totalCoinValue: 1_000 }));
    await writes.recordGift(gift({ transactionId: 't2', senderId: 'minnow', totalCoinValue: 10 }));
    const page = await reads.getLadder(viewer, query(VideoRoomRankingDimension.GIFTERS));
    expect(page.items.map((i) => i.targetId)).toEqual(['whale', 'minnow']);
  });

  it('accumulates repeat gifts from the same sender', async () => {
    await writes.recordGift(gift({ transactionId: 't1', totalCoinValue: 400 }));
    await writes.recordGift(gift({ transactionId: 't2', totalCoinValue: 600 }));
    const page = await reads.getLadder(viewer, query(VideoRoomRankingDimension.GIFTERS));
    expect(page.items[0].score).toBe(1_000);
  });

  it('is idempotent under redelivery of the same transaction', async () => {
    await writes.recordGift(gift());
    await writes.recordGift(gift()); // same transactionId
    const page = await reads.getLadder(viewer, query(VideoRoomRankingDimension.GIFTERS));
    expect(page.items[0].score).toBe(1_000);
  });

  it('keeps the room ladder separate from the global one', async () => {
    await writes.recordGift(gift());
    const global = await reads.getLadder(viewer, query(VideoRoomRankingDimension.GIFTERS));
    const room = await reads.getLadder(viewer, {
      ...query(VideoRoomRankingDimension.GIFTERS),
      scope: 'r:room-1',
    });
    expect(global.items[0].score).toBe(1_000);
    expect(room.items[0].score).toBe(1_000);
  });

  it('never writes into the platform rankings:* namespace', async () => {
    await writes.recordGift(gift());
    const touched = [...(redis as unknown as { zsets: Map<string, unknown> }).zsets.keys()];
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.every((k) => k.startsWith('vrank:'))).toBe(true);
  });

  it('reports the caller their own 1-based rank', async () => {
    await writes.recordGift(gift({ transactionId: 't1', senderId: 'other', totalCoinValue: 9_999 }));
    await writes.recordGift(gift({ transactionId: 't2', senderId: 'whale', totalCoinValue: 10 }));
    const self = await reads.getSelfRank(viewer, VideoRoomRankingDimension.GIFTERS, 'daily');
    expect(self).toEqual(expect.objectContaining({ rank: 2, score: 10 }));
  });

  it('caps a guest at ten entries', async () => {
    for (let i = 0; i < 25; i += 1) {
      await writes.recordGift(gift({ transactionId: `t${i}`, senderId: `u${i}`, totalCoinValue: i + 1 }));
    }
    const page = await reads.getLadder({ id: 'g1', isGuest: true }, {
      ...query(VideoRoomRankingDimension.GIFTERS),
      limit: 100,
    });
    expect(page.items).toHaveLength(10);
  });

  it('credits hosts only for a seated receiver', async () => {
    await writes.recordGift(gift({ transactionId: 't1', receiverIsSeated: false }));
    const page = await reads.getLadder(viewer, query(VideoRoomRankingDimension.HOSTS));
    expect(page.items).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the integration test**

```bash
pnpm test -- src/modules/video-rooms/video-rooms-ranking.integration.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Full verification sweep**

```bash
pnpm test
pnpm lint
pnpm boundaries
pnpm build
```

Expected: every suite PASS; lint, boundaries and build exit 0. **If any pre-existing suite that passed before VR-13 now fails, that is a regression — fix it before reporting.**

- [ ] **Step 5: Report and stop**

Report:
1. Total test count before and after VR-13.
2. Confirmation that `rankings.service.spec.ts` still passes with its original count (the Task 4 safety property).
3. The two migrations awaiting the user's decision to apply, and the `CREATE INDEX CONCURRENTLY` caveat.
4. Any deviation you made from this plan and why.

**Do not commit.** Leave everything as uncommitted working-directory changes.
