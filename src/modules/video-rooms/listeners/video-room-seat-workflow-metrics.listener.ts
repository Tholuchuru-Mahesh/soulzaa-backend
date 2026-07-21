import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  VIDEO_ROOM_SEAT_EVENTS,
  type SeatInvitationDeliveredEvent,
  type SeatInvitationExpiredEvent,
  type SeatInvitationResolvedEvent,
  type SeatInvitationSentEvent,
  type SeatQueueUpdatedEvent,
  type SeatRequestExpiredEvent,
  type SeatRequestResolvedEvent,
} from '../events/video-room-seat.events';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/**
 * VR-8 workflow monitoring, subscribing to the same events the socket listener
 * consumes so metrics stay fully decoupled from the request/invitation services
 * (one event, many independent consumers — the VR-4 pattern).
 *
 * Rates are deliberately NOT tracked here: acceptance rate, delivery rate and
 * promotion success rate are all ratios of these counters and belong in the
 * Prometheus query, not in per-room application state that a restart would lose.
 */
@Injectable()
export class VideoRoomSeatWorkflowMetricsListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly metrics: VideoRoomsMetrics,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<SeatRequestResolvedEvent>(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, (e) => {
      const { status, requestedAt } = e.payload;
      this.metrics.incSeatRequestResolution(status);
      if (status === 'PROMOTED') this.metrics.incSeatPromotion('success');
      if (status === 'FAILED') this.metrics.incSeatPromotion('failure');
      if (requestedAt) {
        const seconds = (Date.now() - new Date(requestedAt).getTime()) / 1000;
        if (Number.isFinite(seconds) && seconds >= 0) {
          this.metrics.observeSeatApprovalLatency(seconds);
        }
      }
    });

    this.bus.subscribe<SeatRequestExpiredEvent>(VIDEO_ROOM_SEAT_EVENTS.REQUEST_EXPIRED, () =>
      this.metrics.incSeatRequestResolution('EXPIRED'),
    );

    this.bus.subscribe<SeatInvitationSentEvent>(VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT, () =>
      this.metrics.incSeatInvitationOutcome('SENT'),
    );
    this.bus.subscribe<SeatInvitationDeliveredEvent>(
      VIDEO_ROOM_SEAT_EVENTS.INVITATION_DELIVERED,
      () => this.metrics.incSeatInvitationOutcome('DELIVERED'),
    );
    this.bus.subscribe<SeatInvitationResolvedEvent>(
      VIDEO_ROOM_SEAT_EVENTS.INVITATION_RESOLVED,
      (e) => this.metrics.incSeatInvitationOutcome(e.payload.status),
    );
    this.bus.subscribe<SeatInvitationExpiredEvent>(VIDEO_ROOM_SEAT_EVENTS.INVITATION_EXPIRED, () =>
      this.metrics.incSeatInvitationOutcome('EXPIRED'),
    );

    this.bus.subscribe<SeatQueueUpdatedEvent>(VIDEO_ROOM_SEAT_EVENTS.QUEUE_UPDATED, (e) =>
      this.metrics.observeSeatQueueDepth(e.payload.size),
    );
  }
}
