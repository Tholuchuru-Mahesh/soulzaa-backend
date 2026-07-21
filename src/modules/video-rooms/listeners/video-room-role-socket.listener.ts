import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_NAMESPACE, VIDEO_ROOM_SOCKET_EVENTS } from '../constants/video-room.constants';
import {
  VIDEO_ROOM_ROLE_EVENTS,
  type OwnershipTransferredEvent,
  type RoleAssignedEvent,
  type RoleRemovedEvent,
  type RoleUpdatedEvent,
  type TemporaryRoleExpiredEvent,
} from '../events/video-room-role.events';

/**
 * Role & ownership events → `/video-room` broadcasts (VR-7). Role services never
 * touch sockets; all fan-out flows through here, mirroring the VR-4 seat and
 * VR-5 media socket listeners.
 *
 * Every change has two audiences. The **room** learns who holds what, so clients
 * can re-render badges and moderator lists. The **affected user** additionally
 * gets a point-to-point `permission_updated`, telling their client its own
 * capability set moved so it refetches `GET /:id/me/permissions` rather than
 * trying to derive the new set from the broadcast.
 */
@Injectable()
export class VideoRoomRoleSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<RoleAssignedEvent>(VIDEO_ROOM_ROLE_EVENTS.ROLE_ASSIGNED, (event) => {
      this.toRoom(event.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.ROLE_ASSIGNED, event.payload);
      this.notify(event.payload.userId, event.payload.roomId);
    });

    this.bus.subscribe<RoleRemovedEvent>(VIDEO_ROOM_ROLE_EVENTS.ROLE_REMOVED, (event) => {
      this.toRoom(event.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.ROLE_REMOVED, event.payload);
      this.notify(event.payload.userId, event.payload.roomId);
    });

    this.bus.subscribe<RoleUpdatedEvent>(VIDEO_ROOM_ROLE_EVENTS.ROLE_UPDATED, (event) => {
      this.toRoom(event.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.ROLE_UPDATED, event.payload);
      this.notify(event.payload.userId, event.payload.roomId);
    });

    // An expiry is a revocation as far as clients are concerned, so it reuses the
    // role_removed channel rather than adding a client event for the same effect.
    this.bus.subscribe<TemporaryRoleExpiredEvent>(
      VIDEO_ROOM_ROLE_EVENTS.TEMPORARY_ROLE_EXPIRED,
      (event) => {
        this.toRoom(event.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.ROLE_REMOVED, event.payload);
        this.notify(event.payload.userId, event.payload.roomId);
      },
    );

    this.bus.subscribe<OwnershipTransferredEvent>(
      VIDEO_ROOM_ROLE_EVENTS.OWNERSHIP_TRANSFERRED,
      (event) => {
        this.toRoom(
          event.payload.roomId,
          VIDEO_ROOM_SOCKET_EVENTS.OWNERSHIP_TRANSFERRED,
          event.payload,
        );
        // Both parties' capabilities moved: one gained the room, one lost it.
        this.notify(event.payload.previousOwnerId, event.payload.roomId);
        this.notify(event.payload.newOwnerId, event.payload.roomId);
      },
    );
  }

  private toRoom(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, event, payload);
  }

  /** Point-to-point: "your capabilities changed in this room — refetch them." */
  private notify(userId: string, roomId: string): void {
    this.sockets.emitToUserEverywhere(userId, VIDEO_ROOM_SOCKET_EVENTS.PERMISSION_UPDATED, {
      roomId,
    });
  }
}
