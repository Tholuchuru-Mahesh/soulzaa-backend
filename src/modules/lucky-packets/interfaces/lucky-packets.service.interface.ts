/**
 * Public contract for the lucky-packets module. Other modules depend only on
 * this token (never on the concrete service or repositories). Kept minimal —
 * the room surface drives everything through the REST controller / EVENT_BUS.
 */
export const LUCKY_PACKETS_SERVICE = Symbol('LUCKY_PACKETS_SERVICE');

/** A live packet summary for connection-recovery reads. */
export interface ActiveLuckyPacket {
  packetId: string;
  roomId: string;
  creatorId: string;
  totalCoins: number;
  winnerCount: number;
  remainingCoins: number;
  remainingSlots: number;
  claimedCount: number;
  expiresAt: Date;
}

export interface ILuckyPacketsService {
  /** All ACTIVE packets in a room (for reconnect/state restore). */
  getActivePackets(roomId: string): Promise<ActiveLuckyPacket[]>;
}
