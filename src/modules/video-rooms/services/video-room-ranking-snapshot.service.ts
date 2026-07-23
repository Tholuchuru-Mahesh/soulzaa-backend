import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  LeaderboardStore,
  RankingPeriodResolver,
  type RankingPeriodName,
} from 'src/modules/rankings/interfaces';
import {
  loadVideoRoomRankingConfig,
  type VideoRoomRankingConfig,
} from '../config/video-room-ranking.config';
import {
  VideoRoomRankingDimension,
  VIDEO_ROOM_RANKING_NAMESPACE,
  VIDEO_ROOM_RANKING_SNAPSHOT_SIZE,
  errorMessage,
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
 *
 * `snapshotAll` deliberately snapshots EVERY dimension, including `hosts` and
 * `rooms` — those two are excluded from the authoritative RECOMPUTE (see
 * `RECOMPUTE_EXCLUDED_DIMENSIONS` in `video-room-ranking-aggregation.service.ts`)
 * because they cannot be reproduced from source tables, but they are still
 * real, correctly-maintained live ladders via the incremental write path.
 * Snapshotting reads Redis, not source data, so that exclusion simply does
 * not apply here: their history is exactly as worth preserving as any other
 * dimension's.
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
      // BigInt, not number: a lifetime coin total can exceed 2^53. The score
      // engine deliberately produces fractional floats (rounding there broke
      // parity between the incremental and recompute paths), so this is the
      // one place that rounds.
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
        // `errorMessage()` is required here, not `(err as Error).message`:
        // `snapshotLadder` awaits `bus.publish`, which fans out to arbitrary
        // subscribers, and a subscriber doing `throw undefined` or a bare
        // `Promise.reject()` would make `(err as Error).message` itself throw
        // a TypeError FROM INSIDE this catch — escaping it and abandoning
        // every remaining dimension, exactly what this catch exists to
        // prevent.
        this.logger.error(
          `snapshot ${dimension}:${period}:${dateKey} failed: ${errorMessage(err)}`,
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
