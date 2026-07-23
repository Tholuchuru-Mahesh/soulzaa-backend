import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { EVENT_BUS } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CacheService } from 'src/infra/redis/cache.service';
import { LockService } from 'src/infra/redis/lock.service';
import { REDIS_CLIENT } from 'src/infra/redis/redis.constants';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import { QueueService } from 'src/infra/queue/queue.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { LeaderboardCache } from 'src/modules/rankings/services/leaderboard-cache.service';
import { LeaderboardStore } from 'src/modules/rankings/services/leaderboard-store.service';
import { RankingPeriodResolver } from 'src/modules/rankings/services/ranking-period.resolver';
import { SOCIAL_SERVICE } from 'src/modules/social/interfaces';
import { VideoRoomRankingDimension } from './constants/video-room-ranking.constants';
import { VideoRoomsRankingsController } from './controllers/video-rooms-rankings.controller';
import { VideoRoomRankingActivityListener } from './listeners/video-room-ranking-activity.listener';
import { VideoRoomRankingAuditListener } from './listeners/video-room-ranking-audit.listener';
import { VideoRoomRankingMetricsListener } from './listeners/video-room-ranking-metrics.listener';
import { VideoRoomRankingSocketListener } from './listeners/video-room-ranking-socket.listener';
import { VideoRoomEventsRepository } from './repositories/video-room-events.repository';
import { VideoRoomPkRepository } from './repositories/video-room-pk.repository';
import { VideoRoomRankingRepository } from './repositories/video-room-ranking.repository';
import { VideoRoomRankingScheduler } from './scheduler/video-room-ranking.scheduler';
import { VideoRoomRankingAggregationService } from './services/video-room-ranking-aggregation.service';
import { VideoRoomRankingJobsService } from './services/video-room-ranking-jobs.service';
import { VideoRoomRankingQueryService } from './services/video-room-ranking-query.service';
import { VideoRoomRankingRecoveryService } from './services/video-room-ranking-recovery.service';
import { VideoRoomRankingScopeResolver } from './services/video-room-ranking-scope.resolver';
import { VideoRoomRankingScoreEngine } from './services/video-room-ranking-score.engine';
import { VideoRoomRankingSnapshotService } from './services/video-room-ranking-snapshot.service';
import { VideoRoomRankingService } from './services/video-room-ranking.service';
import { VideoRoomLeaderboardService } from './services/video-room-leaderboard.service';
import { VideoRoomSeatStateService } from './services/video-room-seat-state.service';
import { VideoRoomsMetrics } from './video-rooms.metrics';

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

  /**
   * Every command `LeaderboardStore.incrementMany`/`bumpVersionMany` can
   * pipeline. `zadd`/`del`/`rename`/`zunionstore` are unused by the flows this
   * spec exercises (no `derive`/`replace` call), so they are stubbed only
   * deeply enough to keep the chain callable, never actually invoked.
   */
  pipeline() {
    const ops: (() => Promise<unknown>)[] = [];
    const chain = {
      zincrby: (k: string, d: number, m: string) => {
        ops.push(() => this.zincrby(k, d, m));
        return chain;
      },
      incr: (k: string) => {
        ops.push(() => this.incr(k));
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

/**
 * VR-13 Task 19 end-to-end.
 *
 * Two independent proofs, mirroring the convention `video-rooms-pk.integration.spec.ts`
 * (VR-12) and `casino.module.spec.ts` established for this repo:
 *
 * 1. "moves a gift..." etc. — the REAL write path (`VideoRoomRankingService`)
 *    and REAL read path (`VideoRoomRankingQueryService`) wired directly to the
 *    REAL ranking-core (`LeaderboardStore`/`LeaderboardCache`/
 *    `RankingPeriodResolver`) over an in-memory Redis double, proving a gift
 *    actually moves a readable ladder end to end — something no per-class unit
 *    spec can prove on its own.
 *
 * 2. 'VR-13 DI graph' — every VR-13 provider `video-rooms.module.ts` registers
 *    (repository, all 9 services, the scheduler, all 4 listeners, and the
 *    controller), constructed through a REAL Nest `TestingModule` exactly as
 *    the module wires them (including the ranking-core classes provided
 *    directly rather than imported via `RankingsModule` — see the module's own
 *    comment for why). This is the check that catches a DI wiring mistake no
 *    unit test can: a missing provider here reproduces Nest's real
 *    "Nest can't resolve dependencies of X (?, ...)" failure at test time
 *    instead of only at server boot.
 */
describe('VR-13 ranking engine (integration)', () => {
  const config = { get: () => ({}) } as never;
  // A fixed, deliberately unremarkable instant (mid-month, mid-day UTC) rather
  // than "now": every internal `new Date()` this test's write/read paths call
  // (period bucketing on both sides) must land on the SAME instant, and a
  // real wall-clock "now" would flip the daily bucket out from under a test
  // run that happens to straddle UTC midnight.
  const AT = new Date('2026-01-15T12:00:00.000Z');
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
    jest.useFakeTimers();
    jest.setSystemTime(AT);

    redis = new FakeRedis();
    store = new LeaderboardStore(redis as never);
    const periods = new RankingPeriodResolver();
    const scoring = new VideoRoomRankingScoreEngine(config);

    writes = new VideoRoomRankingService(
      config,
      store,
      periods,
      scoring,
      // Real constructor is (cache, repo); geography is irrelevant to these
      // assertions, so every attributed user resolves to "no geo" — which is
      // exactly what fans a write out to just [global, room], matching what
      // this spec checks.
      { geoForMany: () => Promise.resolve(new Map()) } as never,
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
      { observeRankingApi: () => undefined } as never,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
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
    await writes.recordGift(
      gift({ transactionId: 't1', senderId: 'whale', totalCoinValue: 1_000 }),
    );
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
    await writes.recordGift(
      gift({ transactionId: 't1', senderId: 'other', totalCoinValue: 9_999 }),
    );
    await writes.recordGift(gift({ transactionId: 't2', senderId: 'whale', totalCoinValue: 10 }));
    const self = await reads.getSelfRank(viewer, VideoRoomRankingDimension.GIFTERS, 'daily');
    expect(self).toEqual(expect.objectContaining({ rank: 2, score: 10 }));
  });

  it('caps a guest at ten entries', async () => {
    for (let i = 0; i < 25; i += 1) {
      await writes.recordGift(
        gift({ transactionId: `t${i}`, senderId: `u${i}`, totalCoinValue: i + 1 }),
      );
    }
    const page = await reads.getLadder(
      { id: 'g1', isGuest: true },
      { ...query(VideoRoomRankingDimension.GIFTERS), limit: 100 },
    );
    expect(page.items).toHaveLength(10);
  });

  it('credits hosts only for a seated receiver', async () => {
    await writes.recordGift(gift({ transactionId: 't1', receiverIsSeated: false }));
    const page = await reads.getLadder(viewer, query(VideoRoomRankingDimension.HOSTS));
    expect(page.items).toEqual([]);
  });
});

describe('VR-13 DI graph (video-rooms.module.ts provider wiring)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      controllers: [VideoRoomsRankingsController],
      providers: [
        // ---- Ranking core, provided directly exactly as video-rooms.module.ts
        // does (never `RankingsModule` — see that module's own comment). ----
        RankingPeriodResolver,
        LeaderboardStore,
        LeaderboardCache,
        // ---- Every VR-13 provider `video-rooms.module.ts` registers. ----
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
        // ---- Everything OUTSIDE the VR-13 set that its constructors need,
        // stood in with a minimal double keyed to the real token/class — the
        // same technique `casino.module.spec.ts` uses to compile a real DI
        // subgraph without pulling in live Prisma/Redis/BullMQ connections. ----
        { provide: ConfigService, useValue: { get: jest.fn(() => ({})) } },
        { provide: PrismaService, useValue: {} },
        { provide: CacheService, useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn() } },
        { provide: REDIS_CLIENT, useValue: {} },
        { provide: LockService, useValue: {} },
        { provide: QueueJobRegistry, useValue: { register: jest.fn() } },
        { provide: QueueService, useValue: {} },
        { provide: SocketManager, useValue: {} },
        { provide: EVENT_BUS, useValue: { publish: jest.fn(), subscribe: jest.fn() } },
        { provide: SOCIAL_SERVICE, useValue: {} },
        // VideoRoomRankingActivityListener's non-VR-13 dependencies (VR-3/VR-12
        // providers already registered elsewhere in video-rooms.module.ts).
        { provide: VideoRoomSeatStateService, useValue: {} },
        { provide: VideoRoomPkRepository, useValue: {} },
        // VideoRoomRankingAuditListener's dependency (a VR-1 provider).
        { provide: VideoRoomEventsRepository, useValue: {} },
        // VideoRoomRankingQueryService's and VideoRoomRankingSocketListener's
        // dependency (a VR-3 provider).
        { provide: VideoRoomsMetrics, useValue: { observeRankingApi: jest.fn() } },
      ],
    }).compile();
  });

  afterAll(async () => {
    // No .init() was called, so no listener's onModuleInit ever subscribed to
    // the (stubbed) bus or registered a (stubbed) queue job — close() still
    // tears the container down cleanly.
    await moduleRef.close();
  });

  it.each([
    ['VideoRoomRankingRepository', VideoRoomRankingRepository],
    ['VideoRoomRankingScoreEngine', VideoRoomRankingScoreEngine],
    ['VideoRoomRankingScopeResolver', VideoRoomRankingScopeResolver],
    ['VideoRoomRankingService', VideoRoomRankingService],
    ['VideoRoomRankingQueryService', VideoRoomRankingQueryService],
    ['VideoRoomLeaderboardService', VideoRoomLeaderboardService],
    ['VideoRoomRankingAggregationService', VideoRoomRankingAggregationService],
    ['VideoRoomRankingSnapshotService', VideoRoomRankingSnapshotService],
    ['VideoRoomRankingRecoveryService', VideoRoomRankingRecoveryService],
    ['VideoRoomRankingJobsService', VideoRoomRankingJobsService],
    ['VideoRoomRankingScheduler', VideoRoomRankingScheduler],
    ['VideoRoomRankingActivityListener', VideoRoomRankingActivityListener],
    ['VideoRoomRankingSocketListener', VideoRoomRankingSocketListener],
    ['VideoRoomRankingMetricsListener', VideoRoomRankingMetricsListener],
    ['VideoRoomRankingAuditListener', VideoRoomRankingAuditListener],
    ['VideoRoomsRankingsController', VideoRoomsRankingsController],
    // The ranking core itself, to prove it resolved as a SINGLE shared
    // instance within this module's injector (see the next test).
    ['RankingPeriodResolver', RankingPeriodResolver],
    ['LeaderboardStore', LeaderboardStore],
    ['LeaderboardCache', LeaderboardCache],
  ])('resolves %s with no DI error', (_name, token) => {
    expect(moduleRef.get(token as never)).toBeInstanceOf(token as never);
  });

  it('gives every VR-13 consumer the SAME ranking-core instances', () => {
    // Every service below independently injects LeaderboardStore; if Nest
    // could not resolve the graph they would not all be constructible, and if
    // it resolved to DIFFERENT instances per consumer (impossible for a
    // module-scoped singleton, but this is the assertion that would catch it
    // if that ever regressed) writes and reads would silently diverge.
    const store = moduleRef.get(LeaderboardStore);
    const writeService = moduleRef.get(VideoRoomRankingService) as unknown as {
      store: LeaderboardStore;
    };
    const queryService = moduleRef.get(VideoRoomRankingQueryService) as unknown as {
      store: LeaderboardStore;
    };
    expect(writeService.store).toBe(store);
    expect(queryService.store).toBe(store);
  });
});
