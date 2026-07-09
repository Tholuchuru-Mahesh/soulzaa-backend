import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  AUDIO_ROOM_EVENTS,
  type RoomDeletedEvent,
  type RoomEndedEvent,
  type RoomLeftEvent,
  type RoomOwnershipTransferredEvent,
} from '../events/audio-room.events';
import { AudioRoomSeatsService } from '../services/audio-room-seats.service';

/**
 * Keeps seat/role state consistent with the room lifecycle by reacting to AR-0
 * room events on the EVENT_BUS — so AudioRoomsService never has to depend on the
 * seat service (respecting one-directional coupling). On leave a member's seat
 * is vacated and the queue advances; on end/delete the stage is cleared; on
 * ownership transfer the OWNER grant + owner seat move to the new owner.
 */
@Injectable()
export class AudioRoomSeatsListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly seats: AudioRoomSeatsService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<RoomLeftEvent>(AUDIO_ROOM_EVENTS.LEFT, (e) =>
      this.seats.onMemberLeave(e.payload.roomId, e.payload.userId),
    );
    this.bus.subscribe<RoomEndedEvent>(AUDIO_ROOM_EVENTS.ENDED, (e) =>
      this.seats.onRoomClosed(e.payload.roomId),
    );
    this.bus.subscribe<RoomDeletedEvent>(AUDIO_ROOM_EVENTS.DELETED, (e) =>
      this.seats.onRoomClosed(e.payload.roomId),
    );
    this.bus.subscribe<RoomOwnershipTransferredEvent>(
      AUDIO_ROOM_EVENTS.OWNERSHIP_TRANSFERRED,
      (e) =>
        this.seats.onOwnershipTransfer(
          e.payload.roomId,
          e.payload.previousOwnerId,
          e.payload.newOwnerId,
          e.payload.actorId,
        ),
    );
  }
}
