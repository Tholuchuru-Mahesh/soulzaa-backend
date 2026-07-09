import { randomInt } from 'node:crypto';
import { LuckyPacketDistribution } from '@prisma/client';

/**
 * Lucky packet constants + the server-only share computation. Locks serialise
 * claims per packet so concurrent claimers can't over-draw a slot or race the
 * remaining-coins counter.
 */

/** Bounds for a packet's parameters (mirrored by the DTO). */
export const LUCKY_PACKET_MIN_WINNERS = 1;
export const LUCKY_PACKET_MAX_WINNERS = 200;
export const LUCKY_PACKET_MIN_TOTAL = 1;
export const LUCKY_PACKET_MAX_TOTAL = 10_000_000;
export const LUCKY_PACKET_MESSAGE_MAX = 120;

/** Claim window bounds (seconds). */
export const LUCKY_PACKET_MIN_EXPIRY_SECONDS = 30;
export const LUCKY_PACKET_MAX_EXPIRY_SECONDS = 24 * 60 * 60;
export const LUCKY_PACKET_DEFAULT_EXPIRY_SECONDS = 15 * 60;

/** Lock guarding a packet's claim critical section (draw + decrement). */
export function luckyPacketLockKey(packetId: string): string {
  return `lucky-packet:{${packetId}}`;
}

/** Lock guarding the fleet-wide lucky-packet expiry sweep. */
export const LUCKY_PACKET_MONITOR_LOCK_KEY = 'lucky-packet:monitor';

/** How often the expiry monitor refunds/expires elapsed packets. */
export const LUCKY_PACKET_MONITOR_INTERVAL_MS = 5_000;

/**
 * Compute one claimant's share, server-side only. `slotIndex` is 0-based over
 * `winnerCount`. The last remaining slot always takes the exact remainder so the
 * sum of all claims equals `totalCoins`.
 *
 * FIXED  — base = floor(total / winnerCount); the first `remainder` slots get
 *          base + 1, the rest get base.
 * RANDOM — a bounded "double-average" draw of the remaining pool, always leaving
 *          at least 1 coin for each still-unclaimed slot.
 *
 * Precondition (enforced at creation): totalCoins >= winnerCount, so every slot
 * receives at least 1 coin.
 */
export function computeClaimAmount(input: {
  distribution: LuckyPacketDistribution;
  totalCoins: number;
  winnerCount: number;
  remainingCoins: number;
  remainingSlots: number;
}): number {
  const { distribution, totalCoins, winnerCount, remainingCoins, remainingSlots } = input;

  // Last slot takes everything that is left — guarantees an exact sum.
  if (remainingSlots <= 1) return remainingCoins;

  if (distribution === LuckyPacketDistribution.FIXED) {
    const base = Math.floor(totalCoins / winnerCount);
    const remainder = totalCoins - base * winnerCount;
    const slotIndex = winnerCount - remainingSlots;
    return base + (slotIndex < remainder ? 1 : 0);
  }

  // RANDOM: reserve 1 coin for each of the other remaining slots, then draw in
  // [1, min(reserveCap, doubleAverage)].
  const reserveCap = remainingCoins - (remainingSlots - 1);
  const doubleAverage = Math.max(1, Math.floor((remainingCoins / remainingSlots) * 2));
  const upper = Math.max(1, Math.min(reserveCap, doubleAverage));
  return randomInt(1, upper + 1); // randomInt upper bound is exclusive
}
