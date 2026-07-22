import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type DomainEvent, type IEventBus } from 'src/common/events';
import {
  VIDEO_ROOM_PK_EVENTS,
  type PkEndedEvent,
  type PkInvitationAcceptedEvent,
  type PkInvitationRejectedEvent,
  type PkInvitationSentEvent,
  type PkRecoveredEvent,
  type PkRewardDistributedEvent,
  type PkScoreUpdatedEvent,
  type PkWinnerDeclaredEvent,
} from '../events/video-room-pk.events';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/**
 * PK Prometheus metrics, driven by events rather than by service calls — the
 * VR-9/VR-10/VR-11 pattern. Keeping the services metric-free means they
 * unit-test without a Prometheus registry, and a metrics change never
 * touches the engine.
 *
 * `video_rooms_pk_active` (`setPkActive`) and
 * `video_rooms_pk_recovery_queue_depth` (`setPkRecoveryQueueDepth`) are
 * deliberately NOT driven from here: Task 20's `VideoRoomPkRecoveryService`
 * already computes both counts as part of its own periodic DB reads
 * (`recordGauges`) and calls `VideoRoomsMetrics` directly — re-deriving them
 * from events here would be a second, drifting source of the same number.
 *
 * Every handler is guarded: a metrics fault must never propagate into the
 * event bus and take a settlement or invitation path down with it.
 */
@Injectable()
export class VideoRoomPkMetricsListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomPkMetricsListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly metrics: VideoRoomsMetrics,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<PkInvitationSentEvent>(VIDEO_ROOM_PK_EVENTS.INVITATION_SENT, () =>
      this.guard(() => this.metrics.incPkInvitationOutcome('sent')),
    );

    this.bus.subscribe<PkInvitationAcceptedEvent>(VIDEO_ROOM_PK_EVENTS.INVITATION_ACCEPTED, () =>
      this.guard(() => this.metrics.incPkInvitationOutcome('accepted')),
    );

    this.bus.subscribe<PkInvitationRejectedEvent>(VIDEO_ROOM_PK_EVENTS.INVITATION_REJECTED, () =>
      this.guard(() => this.metrics.incPkInvitationOutcome('rejected')),
    );

    this.bus.subscribe<PkScoreUpdatedEvent>(VIDEO_ROOM_PK_EVENTS.SCORE_UPDATED, (e) =>
      this.guard(() => {
        this.metrics.incPkGiftThroughput();
        this.observeLatency(e, (s) => this.metrics.observePkScoreLatency(s));
        // `PkScoreUpdatedEvent` is published from `VideoRoomGiftContextHandler`'s
        // `postCommit`, which attempts `VideoRoomPkScoringService.mirror()`'s
        // Redis write FIRST and publishes this event afterward regardless of
        // whether that write throws — a `mirror()` failure is caught and
        // logged there, never re-thrown, so the event still fires. This
        // handler firing therefore does NOT prove the Redis scoreboard HASH
        // was actually written; it only proves a score update was accepted
        // and cleared the broadcast throttle. There is no separate "sync
        // failed" event on the bus to observe a real failure result from, so
        // `incPkRedisSync('success')` is an approximation, not a verified
        // outcome — unchanged here, since correcting that would be a metrics
        // behavior change, not a comment fix.
        this.metrics.incPkRedisSync('success');
      }),
    );

    this.bus.subscribe<PkEndedEvent>(VIDEO_ROOM_PK_EVENTS.ENDED, (e) =>
      this.guard(() => this.metrics.observePkBattleDuration(e.payload.durationSeconds)),
    );

    this.bus.subscribe<PkWinnerDeclaredEvent>(VIDEO_ROOM_PK_EVENTS.WINNER_DECLARED, (e) =>
      this.guard(() => this.observeLatency(e, (s) => this.metrics.observePkWinnerCalculation(s))),
    );

    this.bus.subscribe<PkRewardDistributedEvent>(VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED, (e) =>
      this.guard(() => this.observeLatency(e, (s) => this.metrics.observePkRewardDistribution(s))),
    );

    this.bus.subscribe<PkRecoveredEvent>(VIDEO_ROOM_PK_EVENTS.RECOVERED, (e) =>
      this.guard(() => this.metrics.incPkRecovery(e.payload.reason)),
    );
  }

  /**
   * Latency measured from the event's own timestamp to now — the same
   * technique the VR-11 treasure metrics listener uses, close enough given
   * none of these stages have a stopwatch threaded through them.
   */
  private observeLatency(event: DomainEvent<unknown>, observe: (seconds: number) => void): void {
    const started = Date.parse(event.occurredAt);
    if (Number.isNaN(started)) return;
    observe(Math.max(0, (Date.now() - started) / 1000));
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.logger.warn(`PK metric update failed: ${(err as Error).message}`);
    }
  }
}
