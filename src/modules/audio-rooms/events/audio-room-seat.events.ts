import { RoomMemberRole } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * Audio-room seat/role events on the EVENT_BUS. The module's socket listener
 * bridges these to `seat.*` broadcasts in the `/audio-room` namespace; later
 * domains (analytics, notifications, moderation, wallet) subscribe to the same
 * events without importing this module. `seat.updated` is the catch-all for
 * lock/mute/move/layout/role changes that don't map to a more specific event.
 */
export const AUDIO_ROOM_SEAT_EVENTS = {
  REQUESTED: 'audio_room.seat_requested',
  ACCEPTED: 'audio_room.seat_accepted',
  REJECTED: 'audio_room.seat_rejected',
  LOCKED: 'audio_room.seat_locked',
  UNLOCKED: 'audio_room.seat_unlocked',
  JOINED: 'audio_room.seat_joined',
  LEFT: 'audio_room.seat_left',
  UPDATED: 'audio_room.seat_updated',
} as const;

/** Emitted for the wallet phase to gate a paid Premium Admin seat purchase. */
export const PREMIUM_SEAT_EVENTS = {
  PURCHASE_REQUESTED: 'premium_seat.purchase_requested',
} as const;

export class SeatRequestedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  requestId: string;
  seatIndex: number | null;
  queuePosition: number | null;
  type: string;
}> {
  readonly name = AUDIO_ROOM_SEAT_EVENTS.REQUESTED;
}

export class SeatAcceptedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  requestId: string;
  actorId: string;
  seatIndex: number | null;
}> {
  readonly name = AUDIO_ROOM_SEAT_EVENTS.ACCEPTED;
}

export class SeatRejectedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  requestId: string;
  actorId: string;
}> {
  readonly name = AUDIO_ROOM_SEAT_EVENTS.REJECTED;
}

export class SeatLockedEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
  seatIndex: number;
}> {
  readonly name = AUDIO_ROOM_SEAT_EVENTS.LOCKED;
}

export class SeatUnlockedEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
  seatIndex: number;
}> {
  readonly name = AUDIO_ROOM_SEAT_EVENTS.UNLOCKED;
}

export class SeatJoinedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  seatIndex: number;
}> {
  readonly name = AUDIO_ROOM_SEAT_EVENTS.JOINED;
}

export class SeatLeftEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  seatIndex: number;
}> {
  readonly name = AUDIO_ROOM_SEAT_EVENTS.LEFT;
}

/** Reason discriminator for the catch-all seat/stage change event. */
export type SeatUpdateReason =
  | 'moved'
  | 'muted'
  | 'unmuted'
  | 'room_muted'
  | 'room_unmuted'
  | 'layout_changed'
  | 'role_granted'
  | 'role_revoked'
  | 'speaker_removed'
  | 'invited'
  | 'request_cancelled'
  | 'queue_advanced'
  | 'temp_speak_granted'
  | 'temp_speak_revoked';

/** Catch-all seat/stage change: mute, move, layout, role grant/revoke, room-mute. */
export class SeatUpdatedEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
  reason: SeatUpdateReason;
  seatIndex?: number | null;
  subjectUserId?: string | null;
  role?: RoomMemberRole | null;
}> {
  readonly name = AUDIO_ROOM_SEAT_EVENTS.UPDATED;
}

export class PremiumSeatPurchaseRequestedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  grantedBy: string;
  seatIndex: number | null;
}> {
  readonly name = PREMIUM_SEAT_EVENTS.PURCHASE_REQUESTED;
}
