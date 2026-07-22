import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type DomainEvent, type IEventBus } from 'src/common/events';
import {
  VIDEO_ROOM_TREASURE_EVENTS,
  type TreasureProgressUpdatedEvent,
  type TreasureRewardGeneratedEvent,
  type TreasureUnlockedEvent,
  type TreasureUnlockFailedEvent,
} from '../events/video-room-treasure.events';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/**
 * Treasure metrics, driven by events rather than by service calls (the VR-9 /
 * VR-10 pattern). Keeping the services metric-free means they unit-test without
 * a Prometheus registry, and a metrics change never touches the engine.
 *
 * Every handler is guarded: a metrics fault must never propagate into the event
 * bus and take a payout path down with it.
 */
@Injectable()
export class VideoRoomTreasureMetricsListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomTreasureMetricsListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly metrics: VideoRoomsMetrics,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<TreasureProgressUpdatedEvent>(
      VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED,
      (e) =>
        this.guard(() =>
          this.metrics.setTreasureProgress(
            e.payload.roomId,
            e.payload.level ?? 0,
            e.payload.progress,
          ),
        ),
    );

    this.bus.subscribe<TreasureUnlockedEvent>(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, (e) =>
      this.guard(() => {
        this.metrics.incTreasureUnlock(e.payload.level ?? 0, e.payload.algorithm);
        this.observeLatency(e);
      }),
    );

    this.bus.subscribe<TreasureRewardGeneratedEvent>(
      VIDEO_ROOM_TREASURE_EVENTS.REWARD_GENERATED,
      (e) =>
        this.guard(() =>
          this.metrics.incTreasureMinted(
            e.payload.level ?? 0,
            e.payload.strategy,
            e.payload.poolAmount,
          ),
        ),
    );

    this.bus.subscribe<TreasureUnlockFailedEvent>(VIDEO_ROOM_TREASURE_EVENTS.UNLOCK_FAILED, (e) =>
      this.guard(() => this.metrics.incTreasureFailure(e.payload.stage)),
    );
  }

  /**
   * Distribution latency measured from the event's own timestamp to now — close
   * enough for the 5s SLO without threading a stopwatch through the pipeline.
   */
  private observeLatency(event: DomainEvent<{ level?: number }>): void {
    const started = Date.parse(event.occurredAt);
    if (Number.isNaN(started)) return;
    const seconds = Math.max(0, (Date.now() - started) / 1000);
    this.metrics.observeTreasureDistribution(event.payload.level ?? 0, seconds);
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.logger.warn(`Treasure metric update failed: ${(err as Error).message}`);
    }
  }
}
