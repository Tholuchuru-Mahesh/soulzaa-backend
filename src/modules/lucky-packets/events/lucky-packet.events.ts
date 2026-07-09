import { LuckyPacketDistribution } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * Lucky packet domain events on the EVENT_BUS (AR-14). The audio-rooms module
 * bridges these to the `/audio-room` namespace so every participant sees a new
 * packet appear, live claim progress, completion, and expiry. Analytics /
 * notifications consume the same events without importing this module. Payloads
 * are Number-safe (coins converted from BigInt) and serialisable.
 */
export const LUCKY_PACKET_EVENTS = {
  CREATED: 'lucky_packet.created',
  CLAIMED: 'lucky_packet.claimed',
  COMPLETED: 'lucky_packet.completed',
  EXPIRED: 'lucky_packet.expired',
} as const;

export class LuckyPacketCreatedEvent extends DomainEvent<{
  roomId: string;
  packetId: string;
  creatorId: string;
  currency: string;
  totalCoins: number;
  winnerCount: number;
  distribution: LuckyPacketDistribution;
  message: string | null;
  expiresAt: string;
  createdAt: string;
}> {
  readonly name = LUCKY_PACKET_EVENTS.CREATED;
}

export class LuckyPacketClaimedEvent extends DomainEvent<{
  roomId: string;
  packetId: string;
  userId: string;
  amount: number;
  claimedCount: number;
  winnerCount: number;
  remainingCoins: number;
  remainingSlots: number;
}> {
  readonly name = LUCKY_PACKET_EVENTS.CLAIMED;
}

export class LuckyPacketCompletedEvent extends DomainEvent<{
  roomId: string;
  packetId: string;
  claimedCount: number;
}> {
  readonly name = LUCKY_PACKET_EVENTS.COMPLETED;
}

export class LuckyPacketExpiredEvent extends DomainEvent<{
  roomId: string;
  packetId: string;
  refundedCoins: number;
  claimedCount: number;
}> {
  readonly name = LUCKY_PACKET_EVENTS.EXPIRED;
}
