import { CoinFace, RandomPickPool } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * Room interactive-utility domain events on the EVENT_BUS (AR-15). The
 * audio-rooms module bridges these to the `/audio-room` namespace so every
 * participant sees polls, dice, coin flips, random picks, spins and countdowns
 * in realtime. Payloads are serialisable value records.
 */
export const ROOM_UTIL_EVENTS = {
  POLL_CREATED: 'room_util.poll_created',
  POLL_VOTED: 'room_util.poll_voted',
  POLL_ENDED: 'room_util.poll_ended',
  DICE_ROLLED: 'room_util.dice_rolled',
  COIN_FLIPPED: 'room_util.coin_flipped',
  RANDOM_PICKED: 'room_util.random_picked',
  SPIN_RESULT: 'room_util.spin_result',
  COUNTDOWN_STARTED: 'room_util.countdown_started',
  COUNTDOWN_TICK: 'room_util.countdown_tick',
  COUNTDOWN_PAUSED: 'room_util.countdown_paused',
  COUNTDOWN_RESUMED: 'room_util.countdown_resumed',
  COUNTDOWN_COMPLETED: 'room_util.countdown_completed',
  COUNTDOWN_CANCELLED: 'room_util.countdown_cancelled',
} as const;

/** A poll option tally line. */
export interface PollTally {
  optionId: string;
  label: string;
  voteCount: number;
}

export class PollCreatedEvent extends DomainEvent<{
  roomId: string;
  pollId: string;
  creatorId: string;
  question: string;
  options: PollTally[];
  endsAt: string | null;
  createdAt: string;
}> {
  readonly name = ROOM_UTIL_EVENTS.POLL_CREATED;
}

export class PollVotedEvent extends DomainEvent<{
  roomId: string;
  pollId: string;
  optionId: string;
  userId: string;
  totalVotes: number;
  tallies: PollTally[];
}> {
  readonly name = ROOM_UTIL_EVENTS.POLL_VOTED;
}

export class PollEndedEvent extends DomainEvent<{
  roomId: string;
  pollId: string;
  reason: 'manual' | 'expired';
  totalVotes: number;
  tallies: PollTally[];
  winningOptionId: string | null;
}> {
  readonly name = ROOM_UTIL_EVENTS.POLL_ENDED;
}

export class DiceRolledEvent extends DomainEvent<{
  roomId: string;
  rollId: string;
  userId: string;
  values: number[];
  total: number;
  createdAt: string;
}> {
  readonly name = ROOM_UTIL_EVENTS.DICE_ROLLED;
}

export class CoinFlippedEvent extends DomainEvent<{
  roomId: string;
  flipId: string;
  userId: string;
  result: CoinFace;
  createdAt: string;
}> {
  readonly name = ROOM_UTIL_EVENTS.COIN_FLIPPED;
}

export class RandomPickedEvent extends DomainEvent<{
  roomId: string;
  pickId: string;
  userId: string;
  pool: RandomPickPool;
  pickedUserId: string | null;
  pickedNumber: number | null;
  createdAt: string;
}> {
  readonly name = ROOM_UTIL_EVENTS.RANDOM_PICKED;
}

export class SpinResultEvent extends DomainEvent<{
  roomId: string;
  wheelId: string;
  resultId: string;
  userId: string;
  segmentIndex: number;
  segmentLabel: string;
  rewardCoins: number | null;
  createdAt: string;
}> {
  readonly name = ROOM_UTIL_EVENTS.SPIN_RESULT;
}

interface CountdownPayload {
  roomId: string;
  countdownId: string;
  label: string | null;
  durationSeconds: number;
  remainingSeconds: number;
  endsAt: string | null;
  status: string;
}

export class CountdownStartedEvent extends DomainEvent<CountdownPayload> {
  readonly name = ROOM_UTIL_EVENTS.COUNTDOWN_STARTED;
}
export class CountdownTickEvent extends DomainEvent<CountdownPayload> {
  readonly name = ROOM_UTIL_EVENTS.COUNTDOWN_TICK;
}
export class CountdownPausedEvent extends DomainEvent<CountdownPayload> {
  readonly name = ROOM_UTIL_EVENTS.COUNTDOWN_PAUSED;
}
export class CountdownResumedEvent extends DomainEvent<CountdownPayload> {
  readonly name = ROOM_UTIL_EVENTS.COUNTDOWN_RESUMED;
}
export class CountdownCompletedEvent extends DomainEvent<CountdownPayload> {
  readonly name = ROOM_UTIL_EVENTS.COUNTDOWN_COMPLETED;
}
export class CountdownCancelledEvent extends DomainEvent<CountdownPayload> {
  readonly name = ROOM_UTIL_EVENTS.COUNTDOWN_CANCELLED;
}
