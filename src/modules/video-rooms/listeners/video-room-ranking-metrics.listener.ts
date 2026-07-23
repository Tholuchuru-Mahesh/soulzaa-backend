import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { LeaderboardCache } from 'src/modules/rankings/interfaces';
import { errorMessage } from '../constants/video-room-ranking.constants';
import {
  VIDEO_ROOM_RANKING_EVENTS,
  type RankingAggregatedEvent,
  type RankingMovementPayload,
  type RankingSnapshotCreatedEvent,
} from '../events/video-room-ranking.events';
import { VideoRoomsMetrics } from '../video-rooms.metrics';
import type { DomainEvent } from 'src/common/events';

/**
 * Prometheus fan-out for VR-13, on the shared VideoRoomsMetrics registry.
 *
 * Cache hit rate is DRAINED rather than observed per read: LeaderboardCache
 * counts in-process and this listener transfers the totals on each aggregation
 * tick. Incrementing a Prometheus counter inside the read path would add work
 * to the very requests the cache exists to make fast.
 *
 * Every handler is guarded, matching the VR-11/VR-12 metrics listeners: a
 * metrics fault must never propagate into the event bus and take the socket
 * bridge or the audit listener down with it (the bus fans every subscriber
 * out concurrently, so a throw here is not contained to this listener alone).
 */
@Injectable()
export class VideoRoomRankingMetricsListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomRankingMetricsListener.name);

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
      // Counts movement events per dimension; it does NOT time the write.
      // `RankingMovementPayload` carries no start timestamp (it is published
      // after the write has already committed), so there is no honest duration
      // to observe here — which is why no write-latency histogram exists (see
      // `VideoRoomsMetrics`). Read-path latency lives in `rankingApiLatency`.
      this.bus.subscribe<DomainEvent<RankingMovementPayload>>(name, (e) =>
        this.guard(() => this.metrics.incRankingUpdate(e.payload.dimension)),
      );
    }

    this.bus.subscribe<RankingAggregatedEvent>(VIDEO_ROOM_RANKING_EVENTS.AGGREGATED, (e) =>
      this.guard(() => {
        this.metrics.observeRankingAggregation(e.payload.period, e.payload.durationMs / 1000);
        this.metrics.setRankingLadderSize(e.payload.dimension, e.payload.entriesWritten);
        const { hits, misses } = this.cache.snapshotCounters();
        this.metrics.incRankingCache(hits, misses);
      }),
    );

    this.bus.subscribe<RankingSnapshotCreatedEvent>(
      VIDEO_ROOM_RANKING_EVENTS.SNAPSHOT_CREATED,
      (e) =>
        this.guard(() =>
          this.metrics.observeRankingSnapshot(e.payload.period, e.payload.durationMs / 1000),
        ),
    );
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.logger.warn(`ranking metric update failed: ${errorMessage(err)}`);
    }
  }
}
