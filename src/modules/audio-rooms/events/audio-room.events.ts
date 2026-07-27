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
  PROFILE_UPDATED: 'audio_room.profile_updated',
  DELETED: 'audio_room.deleted',
  STARTED: 'audio_room.started',
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

/**
 * A room's display picture changed. Split out from [RoomUpdatedEvent], which
 * carries only the names of the changed fields: an avatar swap is the one room
 * edit that must reach *every* screen showing the room — the live header, the
 * home and explore cards — and those discovery clients hold no room channel to
 * receive a room-scoped event on, nor a reason to re-fetch the whole room. So
 * this one carries the value and fans out namespace-wide, like `room.live`.
 */
export class RoomProfileUpdatedEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
  imageKey: string | null;
  /** Resolved, directly renderable — clients never touch the raw key. */
  imageUrl: string | null;
}> {
  readonly name = AUDIO_ROOM_EVENTS.PROFILE_UPDATED;
}

export class RoomDeletedEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
  ownerId: string;
}> {
  readonly name = AUDIO_ROOM_EVENTS.DELETED;
}

/**
 * A room went LIVE — a permanent room's new *session*, not a new row (rooms are
 * one-per-owner and never deleted, so "start another live" reactivates the same
 * id). Emitted on both a first go-live and a restart after ENDED/OFFLINE.
 *
 * Unlike the other lifecycle events this payload carries the discovery fields
 * verbatim, because its socket fan-out is namespace-wide: a client that dropped
 * this room when it closed is no longer subscribed to the room's channel and has
 * no cached copy left to patch, so it must be able to render the card straight
 * from the event without a follow-up fetch.
 */
export class RoomStartedEvent extends DomainEvent<{
  roomId: string;
  ownerId: string;
  actorId: string;
  name: string;
  imageKey: string | null;
  imageUrl: string | null;
  categoryId: string | null;
  language: string | null;
  visibility: RoomVisibility;
  isDiscoverable: boolean;
  isLocked: boolean;
  isPasswordProtected: boolean;
  maxParticipants: number;
  participantCount: number;
  status: string;
  /** True when this restarted a previously ended room (vs. a first go-live). */
  restarted: boolean;
}> {
  readonly name = AUDIO_ROOM_EVENTS.STARTED;
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
