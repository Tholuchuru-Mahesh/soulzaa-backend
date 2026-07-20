import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  VIDEO_ROOM_SEAT_EVENTS,
  type SeatInvitationSentEvent,
  type SeatLeftEvent,
  type SeatLockedEvent,
  type SeatReleasedEvent,
  type SeatRequestedEvent,
  type SeatSwitchedEvent,
  type SeatTakenEvent,
  type SeatTransferredEvent,
  type SeatUnlockedEvent,
} from '../events/video-room-seat.events';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/**
 * Keeps the VR-4 seat Prometheus metrics current by subscribing to the same seat
 * domain events the socket listener consumes — so monitoring stays decoupled from
 * the occupancy services (one event, many independent consumers). Occupancy/lock
 * gauges move on the authoritative take/left/lock/unlock events; the rest are
 * operation counters.
 */
@Injectable()
export class VideoRoomSeatMetricsListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly metrics: VideoRoomsMetrics,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<SeatTakenEvent>(VIDEO_ROOM_SEAT_EVENTS.TAKEN, () =>
      this.metrics.incOccupiedSeat(),
    );
    this.bus.subscribe<SeatLeftEvent>(VIDEO_ROOM_SEAT_EVENTS.LEFT, () =>
      this.metrics.decOccupiedSeat(),
    );
    this.bus.subscribe<SeatLockedEvent>(VIDEO_ROOM_SEAT_EVENTS.LOCKED, () =>
      this.metrics.incLockedSeat(),
    );
    this.bus.subscribe<SeatUnlockedEvent>(VIDEO_ROOM_SEAT_EVENTS.UNLOCKED, () =>
      this.metrics.decLockedSeat(),
    );
    this.bus.subscribe<SeatTransferredEvent>(VIDEO_ROOM_SEAT_EVENTS.TRANSFERRED, () =>
      this.metrics.incSeatTransfer(),
    );
    this.bus.subscribe<SeatSwitchedEvent>(VIDEO_ROOM_SEAT_EVENTS.SWITCHED, () =>
      this.metrics.incSeatSwitch(),
    );
    this.bus.subscribe<SeatRequestedEvent>(VIDEO_ROOM_SEAT_EVENTS.REQUESTED, () =>
      this.metrics.incSeatRequest(),
    );
    this.bus.subscribe<SeatInvitationSentEvent>(VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT, () =>
      this.metrics.incSeatInvitation(),
    );
    this.bus.subscribe<SeatReleasedEvent>(VIDEO_ROOM_SEAT_EVENTS.RELEASED, (e) => {
      if (e.payload.reason === 'expired') this.metrics.incReservationTimeout();
    });
  }
}
