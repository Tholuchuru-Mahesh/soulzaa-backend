import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { AUDIO_ROOM_NAMESPACE, ROOM_SOCKET_EVENTS } from '../constants/audio-room.constants';
import {
  AUDIO_ROOM_EVENTS,
  type RoomCreatedEvent,
  type RoomDeletedEvent,
  type RoomEndedEvent,
  type RoomJoinedEvent,
  type RoomLeftEvent,
  type RoomLockedEvent,
  type RoomOwnershipTransferredEvent,
  type RoomUpdatedEvent,
} from '../events/audio-room.events';
import {
  AUDIO_ROOM_SEAT_EVENTS,
  type SeatAcceptedEvent,
  type SeatJoinedEvent,
  type SeatLeftEvent,
  type SeatLockedEvent,
  type SeatRejectedEvent,
  type SeatRequestedEvent,
  type SeatUnlockedEvent,
  type SeatUpdatedEvent,
} from '../events/audio-room-seat.events';
import { AudioRoomsRepository } from '../repositories/audio-rooms.repository';
import { PresenceService } from 'src/infra/redis/presence.service';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import { USER_EVENTS, type UserAvatarUpdatedEvent } from 'src/modules/users/events/user.events';

/**
 * Bridges audio-room domain events on the EVENT_BUS to realtime `room.*`
 * broadcasts into the `/audio-room` Socket.IO namespace room, cross-instance via
 * the Redis adapter. Keeps the module free of a direct gateway dependency —
 * mirrors the session module's socket listener. The infra AudioRoomGateway stays
 * a thin transport shell; all domain fan-out flows through here.
 */
@Injectable()
export class AudioRoomSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
    private readonly repo: AudioRoomsRepository,
    private readonly presence: PresenceService,
    @Inject(PROFILE_SERVICE) private readonly profileService: IProfileService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<RoomCreatedEvent>(AUDIO_ROOM_EVENTS.CREATED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.CREATED, e.payload),
    );
    this.bus.subscribe<RoomUpdatedEvent>(AUDIO_ROOM_EVENTS.UPDATED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.UPDATED, e.payload),
    );
    this.bus.subscribe<RoomDeletedEvent>(AUDIO_ROOM_EVENTS.DELETED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.DELETED, e.payload),
    );
    this.bus.subscribe<RoomEndedEvent>(AUDIO_ROOM_EVENTS.ENDED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.CLOSED, e.payload),
    );
    this.bus.subscribe<RoomJoinedEvent>(AUDIO_ROOM_EVENTS.JOINED, async (e) => {
      const payload = await this.getAudiencePreviewPayload(
        e.payload.roomId,
        e.payload.participantCount,
      );
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.JOINED, {
        ...e.payload,
        ...payload,
      });
    });
    this.bus.subscribe<RoomLeftEvent>(AUDIO_ROOM_EVENTS.LEFT, async (e) => {
      const payload = await this.getAudiencePreviewPayload(
        e.payload.roomId,
        e.payload.participantCount,
      );
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.LEFT, {
        ...e.payload,
        ...payload,
      });
    });
    this.bus.subscribe<RoomLockedEvent>(AUDIO_ROOM_EVENTS.LOCKED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.LOCKED, e.payload),
    );
    this.bus.subscribe<RoomOwnershipTransferredEvent>(
      AUDIO_ROOM_EVENTS.OWNERSHIP_TRANSFERRED,
      (e) => this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.OWNERSHIP_TRANSFERRED, e.payload),
    );

    // Listen to user avatar updates to keep audience preview avatars synchronized in realtime
    this.bus.subscribe<UserAvatarUpdatedEvent>(USER_EVENTS.AVATAR_UPDATED, async (e) => {
      if (e.payload.kind === 'avatar') {
        const rooms = await this.presence.userRooms(e.payload.userId);
        for (const roomId of rooms) {
          const count = await this.presence.roomMemberCount(roomId);
          const payload = await this.getAudiencePreviewPayload(roomId, count);
          this.emit(roomId, ROOM_SOCKET_EVENTS.JOINED, payload);
        }
      }
    });

    // ---- Seats (AR-1) ----
    this.bus.subscribe<SeatRequestedEvent>(AUDIO_ROOM_SEAT_EVENTS.REQUESTED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.SEAT_REQUESTED, e.payload),
    );
    this.bus.subscribe<SeatAcceptedEvent>(AUDIO_ROOM_SEAT_EVENTS.ACCEPTED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.SEAT_ACCEPTED, e.payload),
    );
    this.bus.subscribe<SeatRejectedEvent>(AUDIO_ROOM_SEAT_EVENTS.REJECTED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.SEAT_REJECTED, e.payload),
    );
    this.bus.subscribe<SeatLockedEvent>(AUDIO_ROOM_SEAT_EVENTS.LOCKED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.SEAT_LOCKED, e.payload),
    );
    this.bus.subscribe<SeatUnlockedEvent>(AUDIO_ROOM_SEAT_EVENTS.UNLOCKED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.SEAT_UNLOCKED, e.payload),
    );
    this.bus.subscribe<SeatJoinedEvent>(AUDIO_ROOM_SEAT_EVENTS.JOINED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.SEAT_JOINED, e.payload),
    );
    this.bus.subscribe<SeatLeftEvent>(AUDIO_ROOM_SEAT_EVENTS.LEFT, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.SEAT_LEFT, e.payload),
    );
    this.bus.subscribe<SeatUpdatedEvent>(AUDIO_ROOM_SEAT_EVENTS.UPDATED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.SEAT_UPDATED, e.payload),
    );
  }

  private async getAudiencePreviewPayload(roomId: string, count: number) {
    const members = await this.repo.listFirstActiveMembers(roomId, 3);
    const ids = members.map((m) => m.userId);
    const identities = await this.profileService.resolvePublicIdentities(ids);
    const visibleParticipants = ids.map((id) => {
      const identity = identities.get(id);
      return {
        userId: id,
        username: identity?.displayName ?? '',
        profileImage: identity?.avatarUrl ?? null,
      };
    });
    return {
      roomId,
      audienceCount: count,
      visibleParticipants,
    };
  }

  private emit(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(AUDIO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
