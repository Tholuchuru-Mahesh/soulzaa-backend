import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  VIDEO_ROOM_EVENTS,
  type RoomClosedEvent,
  type RoomDeletedEvent,
  type UserLeftEvent,
} from '../events/video-room.events';
import { VideoRoomSeatService } from '../services/video-room-seat.service';

/**
 * Keeps the seat stage consistent with the room lifecycle (VR-4). Reacts to room
 * events on the EVENT_BUS — a leaving member frees their seat; a closed/deleted room
 * drops the live snapshot — so the seat slice never depends on the lifecycle service
 * directly (one-directional coupling, mirroring the Audio-Room seats listener).
 */
@Injectable()
export class VideoRoomSeatLifecycleListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly seats: VideoRoomSeatService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<UserLeftEvent>(VIDEO_ROOM_EVENTS.USER_LEFT, (e) =>
      this.seats.onMemberLeave(e.payload.roomId, e.payload.userId),
    );
    this.bus.subscribe<RoomClosedEvent>(VIDEO_ROOM_EVENTS.CLOSED, (e) =>
      this.seats.onRoomClosed(e.payload.roomId),
    );
    this.bus.subscribe<RoomDeletedEvent>(VIDEO_ROOM_EVENTS.DELETED, (e) =>
      this.seats.onRoomClosed(e.payload.roomId),
    );
  }
}
