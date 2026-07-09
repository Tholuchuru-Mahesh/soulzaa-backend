import { DomainEvent } from 'src/common/events';

/**
 * AR-9 premium-feature events. The premium socket listener bridges these to the
 * `/audio-room` namespace so participants see premium-admin grants/expiries and
 * watch-party state changes in realtime.
 */
export const AUDIO_ROOM_PREMIUM_EVENTS = {
  PREMIUM_SEAT_GRANTED: 'audio_room.premium_seat_granted',
  PREMIUM_SEAT_ENDED: 'audio_room.premium_seat_ended',
  WATCH_PARTY_UPDATED: 'audio_room.watch_party_updated',
} as const;

export class PremiumSeatGrantedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  seatId: string;
  expiresAt: string;
}> {
  readonly name = AUDIO_ROOM_PREMIUM_EVENTS.PREMIUM_SEAT_GRANTED;
}

export class PremiumSeatEndedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  seatId: string;
  reason: 'expired' | 'revoked';
}> {
  readonly name = AUDIO_ROOM_PREMIUM_EVENTS.PREMIUM_SEAT_ENDED;
}

export class WatchPartyUpdatedEvent extends DomainEvent<{
  roomId: string;
  videoId: string | null;
  status: string;
  positionSeconds: number;
  controlledBy: string | null;
}> {
  readonly name = AUDIO_ROOM_PREMIUM_EVENTS.WATCH_PARTY_UPDATED;
}
