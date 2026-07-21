import { DomainEvent } from 'src/common/events';

/**
 * Video-room seat domain events on the EVENT_BUS (VR-4). The module's own
 * `VideoRoomSeatSocketListener` bridges these to `video_room.seat_*` broadcasts;
 * downstream domains (analytics, notifications) may subscribe without importing this
 * module. Occupancy events carry the snapshot `version` so clients reconcile
 * out-of-order syncs; request/invitation events carry the durable row id.
 */
export const VIDEO_ROOM_SEAT_EVENTS = {
  TAKEN: 'video_room.seat_taken',
  LEFT: 'video_room.seat_left',
  LOCKED: 'video_room.seat_locked',
  UNLOCKED: 'video_room.seat_unlocked',
  RESERVED: 'video_room.seat_reserved',
  RELEASED: 'video_room.seat_released',
  REQUESTED: 'video_room.seat_requested',
  REQUEST_RESOLVED: 'video_room.seat_request_resolved',
  INVITATION_SENT: 'video_room.seat_invitation_sent',
  INVITATION_RESOLVED: 'video_room.seat_invitation_resolved',
  SWITCHED: 'video_room.seat_switched',
  TRANSFERRED: 'video_room.seat_transferred',
  UPDATED: 'video_room.seat_updated',
  SYNC: 'video_room.seat_sync',
  REQUEST_EXPIRED: 'video_room.seat_request_expired',
  INVITATION_EXPIRED: 'video_room.seat_invitation_expired',
  INVITATION_DELIVERED: 'video_room.seat_invitation_delivered',
  QUEUE_UPDATED: 'video_room.seat_queue_updated',
} as const;

export type SeatRequestResolution =
  'ACCEPTED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'PROMOTED' | 'FAILED';
export type SeatInvitationResolution = 'ACCEPTED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
export type SeatReleaseReason = 'cancelled' | 'expired';

export class SeatTakenEvent extends DomainEvent<{
  roomId: string;
  version: number;
  seatIndex: number;
  userId: string;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.TAKEN;
}

export class SeatLeftEvent extends DomainEvent<{
  roomId: string;
  version: number;
  seatIndex: number;
  userId: string;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.LEFT;
}

export class SeatLockedEvent extends DomainEvent<{
  roomId: string;
  version: number;
  seatIndex: number;
  actorId: string;
  reason: string | null;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.LOCKED;
}

export class SeatUnlockedEvent extends DomainEvent<{
  roomId: string;
  version: number;
  seatIndex: number;
  actorId: string;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.UNLOCKED;
}

export class SeatReservedEvent extends DomainEvent<{
  roomId: string;
  version: number;
  seatIndex: number;
  reservedForUserId: string;
  actorId: string;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.RESERVED;
}

export class SeatReleasedEvent extends DomainEvent<{
  roomId: string;
  version: number;
  seatIndex: number;
  reason: SeatReleaseReason;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.RELEASED;
}

export class SeatRequestedEvent extends DomainEvent<{
  roomId: string;
  requestId: string;
  userId: string;
  seatIndex: number | null;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.REQUESTED;
}

export class SeatRequestResolvedEvent extends DomainEvent<{
  roomId: string;
  requestId: string;
  userId: string;
  status: SeatRequestResolution;
  actorId?: string | null;
  version?: number;
  seatIndex?: number | null;
  /** ISO timestamp of the original request — drives the approval-latency histogram. */
  requestedAt?: string;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED;
}

export class SeatInvitationSentEvent extends DomainEvent<{
  roomId: string;
  invitationId: string;
  inviterId: string;
  inviteeUserId: string;
  seatIndex: number | null;
  expiresAt: string;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT;
}

export class SeatInvitationResolvedEvent extends DomainEvent<{
  roomId: string;
  invitationId: string;
  inviteeUserId: string;
  status: SeatInvitationResolution;
  version?: number;
  seatIndex?: number | null;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.INVITATION_RESOLVED;
}

export class SeatSwitchedEvent extends DomainEvent<{
  roomId: string;
  version: number;
  userId: string;
  fromSeatIndex: number;
  toSeatIndex: number;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.SWITCHED;
}

export class SeatTransferredEvent extends DomainEvent<{
  roomId: string;
  version: number;
  userId: string;
  fromSeatIndex: number | null;
  toSeatIndex: number;
  actorId: string;
  forced: boolean;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.TRANSFERRED;
}

export class SeatUpdatedEvent extends DomainEvent<{
  roomId: string;
  version: number;
  seatIndex: number | null;
  reason: string;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.UPDATED;
}

export class SeatSyncEvent extends DomainEvent<{
  roomId: string;
  version: number;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.SYNC;
}

/** One row in the bounded queue preview carried by `SeatQueueUpdatedEvent`. */
export interface QueuePreviewEntry {
  userId: string;
  /** 1-based position in the queue. */
  position: number;
  vipLevel: number;
}

/** A PENDING seat request passed its TTL and was expired by the monitor sweep. */
export class SeatRequestExpiredEvent extends DomainEvent<{
  roomId: string;
  requestId: string;
  userId: string;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.REQUEST_EXPIRED;
}

/** A PENDING/DELIVERED invitation passed its TTL and was expired by the sweep. */
export class SeatInvitationExpiredEvent extends DomainEvent<{
  roomId: string;
  invitationId: string;
  inviteeUserId: string;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.INVITATION_EXPIRED;
}

/** The invitee's client acknowledged receipt of an invitation. */
export class SeatInvitationDeliveredEvent extends DomainEvent<{
  roomId: string;
  invitationId: string;
  inviteeUserId: string;
  deliveredAt: string;
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.INVITATION_DELIVERED;
}

/**
 * The seat queue changed (join, leave, resolve, expire, advance, re-score).
 * `top` is truncated to VIDEO_ROOM_QUEUE_PREVIEW_LIMIT — never the whole queue,
 * so a very deep queue cannot blow up a broadcast frame.
 */
export class SeatQueueUpdatedEvent extends DomainEvent<{
  roomId: string;
  size: number;
  top: QueuePreviewEntry[];
}> {
  readonly name = VIDEO_ROOM_SEAT_EVENTS.QUEUE_UPDATED;
}
