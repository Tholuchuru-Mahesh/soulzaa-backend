import { randomInt } from 'node:crypto';

/**
 * Room interactive-utility constants + small server-side RNG helpers. Locks
 * serialise the vote / countdown-start critical sections so concurrent actions
 * can't double-count a tally or create two active countdowns in a room.
 */

// ---- Polls ----
export const POLL_QUESTION_MAX = 200;
export const POLL_OPTION_LABEL_MAX = 80;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 8;
export const POLL_MIN_DURATION_SECONDS = 10;
export const POLL_MAX_DURATION_SECONDS = 24 * 60 * 60;

// ---- Dice ----
export const DICE_MIN_COUNT = 1;
export const DICE_MAX_COUNT = 6;
export const DICE_FACES = 6;

// ---- Random picker ----
export const RANDOM_PICK_MIN = -1_000_000;
export const RANDOM_PICK_MAX = 1_000_000;

// ---- Spin wheel ----
export const SPIN_MIN_SEGMENTS = 2;
export const SPIN_MAX_SEGMENTS = 12;
export const SPIN_SEGMENT_LABEL_MAX = 40;
export const SPIN_TITLE_MAX = 60;
export const SPIN_SEGMENT_MAX_WEIGHT = 1_000_000;
export const SPIN_SEGMENT_MAX_REWARD = 1_000_000;

// ---- Countdown ----
export const COUNTDOWN_LABEL_MAX = 60;
export const COUNTDOWN_MIN_SECONDS = 5;
export const COUNTDOWN_MAX_SECONDS = 24 * 60 * 60;
export const COUNTDOWN_MONITOR_INTERVAL_MS = 1_000;
export const COUNTDOWN_MONITOR_LOCK_KEY = 'room-countdown:monitor';

/** A spin-wheel segment as stored in the wheel's `segments` JSON. */
export interface SpinSegment {
  label: string;
  weight: number;
  color?: string;
  rewardCoins?: number;
}

/** Lock guarding a poll's vote critical section (insert + tally increment). */
export function pollLockKey(pollId: string): string {
  return `room-poll:{${pollId}}`;
}

/** Lock guarding a room's "start countdown" critical section. */
export function countdownRoomLockKey(roomId: string): string {
  return `room-countdown:room:{${roomId}}`;
}

/** Lock guarding a room's spin critical section (weighted draw + reward). */
export function spinLockKey(wheelId: string): string {
  return `spin-wheel:{${wheelId}}`;
}

/** Roll `count` fair d6 dice server-side. */
export function rollDice(count: number): { values: number[]; total: number } {
  const values = Array.from({ length: count }, () => randomInt(1, DICE_FACES + 1));
  return { values, total: values.reduce((a, b) => a + b, 0) };
}

/** Pick a uniformly-random element index from `size` candidates. */
export function pickIndex(size: number): number {
  return randomInt(0, size);
}

/** Pick a uniformly-random integer in the inclusive range [min, max]. */
export function pickNumber(min: number, max: number): number {
  return randomInt(min, max + 1);
}

/**
 * Draw a segment index from a weighted distribution, server-side. Weights are
 * positive integers; the returned index is uniform over the total weight.
 */
export function drawWeightedSegment(segments: SpinSegment[]): number {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.weight), 0);
  if (total <= 0) return pickIndex(segments.length);
  let roll = randomInt(0, total);
  for (let i = 0; i < segments.length; i++) {
    roll -= Math.max(0, segments[i].weight);
    if (roll < 0) return i;
  }
  return segments.length - 1;
}
