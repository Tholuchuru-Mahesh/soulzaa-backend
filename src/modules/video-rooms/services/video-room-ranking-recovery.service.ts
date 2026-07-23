import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LeaderboardStore, type RankingPeriodName } from 'src/modules/rankings/interfaces';
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
  RECOMPUTE_EXCLUDED_DIMENSIONS,
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
   *
   * Invalidation goes through `repo.invalidateAggregation`, NOT
   * `repo.failAggregation`. The two look similar but mean different things:
   * `failAggregation` records that a RUN failed, and is only ever called by
   * the aggregation service on a row it just created moments earlier via
   * `beginAggregation` — so its `update` is safe there because the row is
   * guaranteed to exist. `replay` has no such guarantee: the single most
   * likely reason to use this tool is an operator backfilling a window the
   * scheduler never touched, meaning NO log row exists for ANY dimension yet.
   * `invalidateAggregation` uses `updateMany`, which resolves `{ count: 0 }`
   * instead of throwing when nothing matches — exactly the "clear it if it's
   * there, no-op if it isn't" semantic a replay needs.
   *
   * `hosts` and `rooms` are skipped here on purpose: `recomputeAll` refuses to
   * recompute either (see `RECOMPUTE_EXCLUDED_DIMENSIONS` — reused from here
   * rather than duplicated) and its `recomputeDimension` returns SKIPPED for
   * them WITHOUT ever calling `repo.beginAggregation`, so neither dimension
   * necessarily has an aggregation-log row for this window at all. Invalidating
   * a guard `recomputeAll` will never re-claim would be pointless. The live
   * incremental path remains authoritative for both — a replay cannot and
   * must not touch them.
   */
  async replay(period: RankingPeriodName, dateKey: string): Promise<AggregationResult[]> {
    this.logger.warn(`replaying rankings for ${period}:${dateKey}`);

    for (const dimension of Object.values(VideoRoomRankingDimension)) {
      if (RECOMPUTE_EXCLUDED_DIMENSIONS.has(dimension)) continue;
      const cleared = await this.repo.invalidateAggregation(
        { scope: scopeGlobal(), dimension, period, dateKey },
        'invalidated by operator replay',
      );
      this.logger.debug(`${dimension}:${period}:${dateKey} guard cleared (${cleared} row(s))`);
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
