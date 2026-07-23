import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import { LockService } from 'src/infra/redis/lock.service';
import { RankingPeriodResolver, type RankingPeriodName } from 'src/modules/rankings/interfaces';
import {
  VideoRoomRankingDimension,
  VIDEO_ROOM_RANKING_JOBS,
  errorMessage,
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
 * inside `VideoRoomRankingAggregationService`) stops a REDELIVERED job from
 * redoing finished work. Each covers a case the other cannot.
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
      // Derivation runs for ALL seven dimensions — `derivePeriod` is a pure
      // Redis ZUNIONSTORE over the hot monthly keys the live path maintains
      // for every dimension, including `hosts`/`rooms`, which are excluded
      // only from the source-table RECOMPUTE, not from this.
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
        this.logger.warn(`failed to release ${lockKey}: ${errorMessage(err)}`);
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
