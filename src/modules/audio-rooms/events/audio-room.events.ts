import { RoomVisibility } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * Audio-room lifecycle events on the EVENT_BUS. The module's own socket
 * listener consumes these to broadcast `room.*` to the `/audio-room` namespace;
 * later domains (analytics, notifications, rankings, EXP) subscribe to the same
 * events without importing this module. Payloads are serialisable id-carrying
 * records so the transport can move in-process → Redis/Kafka unchanged.
 */
export const AUDIO_ROOM_EVENTS = {
  CREATED: 'audio_room.created',
  UPDATED: 'audio_room.updated',
  DELETED: 'audio_room.deleted',
  ENDED: 'audio_room.ended',
  JOINED: 'audio_room.joined',
  LEFT: 'audio_room.left',
  LOCKED: 'audio_room.locked',
  OWNERSHIP_TRANSFERRED: 'audio_room.ownership_transferred',
} as const;

export class RoomCreatedEvent extends DomainEvent<{
  roomId: string;
  ownerId: string;
  name: string;
  categoryId: string | null;
  language: string | null;
  visibility: RoomVisibility;
}> {
  readonly name = AUDIO_ROOM_EVENTS.CREATED;
}

export class RoomUpdatedEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
  changed: string[];
}> {
  readonly name = AUDIO_ROOM_EVENTS.UPDATED;
}

export class RoomDeletedEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
  ownerId: string;
}> {
  readonly name = AUDIO_ROOM_EVENTS.DELETED;
}

export class RoomEndedEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
  ownerId: string;
  durationSeconds: number;
}> {
  readonly name = AUDIO_ROOM_EVENTS.ENDED;
}

export class RoomJoinedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  participantCount: number;
}> {
  readonly name = AUDIO_ROOM_EVENTS.JOINED;
}

export class RoomLeftEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  participantCount: number;
}> {
  readonly name = AUDIO_ROOM_EVENTS.LEFT;
}

export class RoomLockedEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
  isLocked: boolean;
}> {
  readonly name = AUDIO_ROOM_EVENTS.LOCKED;
}

export class RoomOwnershipTransferredEvent extends DomainEvent<{
  roomId: string;
  previousOwnerId: string;
  newOwnerId: string;
  actorId: string;
}> {
  readonly name = AUDIO_ROOM_EVENTS.OWNERSHIP_TRANSFERRED;
}
