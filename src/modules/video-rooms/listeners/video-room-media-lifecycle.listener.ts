import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VideoRoomSnapshotReason } from '@prisma/client';
import type { RoomActor } from '../interfaces/room-actor.interface';
import {
  VIDEO_ROOM_EVENTS,
  type RoomClosedEvent,
  type RoomDeletedEvent,
  type UserLeftEvent,
} from '../events/video-room.events';
import {
  VIDEO_ROOM_SEAT_EVENTS,
  type SeatLeftEvent,
} from '../events/video-room-seat.events';
import { VideoRoomMediaService } from '../services/video-room-media.service';
import { VideoRoomMediaStateService } from '../services/video-room-media-state.service';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';

/**
 * Keeps the media slice consistent with room/member lifecycle (VR-5) — one-directional,
 * no dependency back into lifecycle, mirroring VideoRoomSeatLifecycleListener. On room
 * CLOSED/DELETED: persist the live media stage as a PRE_SHUTDOWN snapshot, then drop the
 * live Redis snapshot. On USER_LEFT: end that user's media session.
 * On SEAT_LEFT: demote the vacated occupant to subscriber so camera/mic publishing stops.
 */
@Injectable()
export class VideoRoomMediaLifecycleListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly media: VideoRoomMediaService,
    private readonly mediaState: VideoRoomMediaStateService,
    private readonly events: VideoRoomEventsRepository,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<RoomClosedEvent>(VIDEO_ROOM_EVENTS.CLOSED, (e) =>
      this.teardownRoom(e.payload.roomId),
    );
    this.bus.subscribe<RoomDeletedEvent>(VIDEO_ROOM_EVENTS.DELETED, (e) =>
      this.teardownRoom(e.payload.roomId),
    );
    this.bus.subscribe<UserLeftEvent>(VIDEO_ROOM_EVENTS.USER_LEFT, async (e) => {
      await this.media.leaveMedia(
        { id: e.payload.userId, roles: [] } as RoomActor,
        e.payload.roomId,
      );
    });
    this.bus.subscribe<SeatLeftEvent>(VIDEO_ROOM_SEAT_EVENTS.LEFT, async (e) => {
      try {
        await this.media.demoteToSubscriber(e.payload.roomId, e.payload.userId, 'system');
      } catch {
        // Idempotent / best-effort — demoteToSubscriber handles unseated/non-publishing cleanly.
      }
    });
  }

  private async teardownRoom(roomId: string): Promise<void> {
    const snap = await this.mediaState.getSnapshot(roomId);
    if (snap) {
      await this.events.saveSnapshot({
        roomId,
        version: snap.version,
        reason: VideoRoomSnapshotReason.PRE_SHUTDOWN,
        state: snap as never,
      });
    }
    await this.mediaState.clear(roomId);
  }
}
