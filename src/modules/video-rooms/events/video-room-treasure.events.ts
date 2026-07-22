import { DomainEvent } from 'src/common/events';
import type { TreasureUnlockStage } from '../constants/video-room-treasure.constants';

/**
 * VR-11 treasure events.
 *
 * Every payload extends `TreasureEventBase`, so a consumer — socket bridge,
 * metrics listener, audit listener — can correlate any event back to its room,
 * session, box and level without a lookup. One `correlationId` threads a
 * complete unlock lifecycle (pool → winners → each payout → unlocked) through
 * `VideoRoomEvent`, which is what makes the audit trail readable as a causal
 * chain rather than a pile of rows.
 */
export const VIDEO_ROOM_TREASURE_EVENTS = {
  CREATED: 'video_room.treasure.created',
  STARTED: 'video_room.treasure.started',
  PROGRESS_UPDATED: 'video_room.treasure.progress_updated',
  UNLOCKED: 'video_room.treasure.unlocked',
  REWARD_GENERATED: 'video_room.treasure.reward_generated',
  WINNER_SELECTED: 'video_room.treasure.winner_selected',
  REWARD_DISTRIBUTED: 'video_room.treasure.reward_distributed',
  CLOSED: 'video_room.treasure.closed',
  RECOVERED: 'video_room.treasure.recovered',
  UNLOCK_FAILED: 'video_room.treasure.unlock_failed',
} as const;

/** The correlation envelope every treasure event carries. */
export interface TreasureEventBase {
  correlationId: string;
  roomId: string;
  sessionId: string;
  boxId?: string;
  level?: number;
  /** Present when a gift batch originated the event. */
  batchId?: string;
  /**
   * The originating HTTP request id (pino's `req.id`), when there was one.
   *
   * Present on owner-driven lifecycle events, which are raised inside a request.
   * ABSENT on the unlock chain by nature: those events are raised on a BullMQ
   * worker where no request exists, and `correlationId` — which threads the
   * whole pool → winners → payouts → unlocked sequence — is the identifier that
   * actually carries meaning there.
   */
  requestId?: string;
}

export interface TreasureWinnerPayload {
  userId: string;
  amount: number;
  shareBps: number;
}

export class TreasureCreatedEvent extends DomainEvent<
  TreasureEventBase & { createdBy: string; levels: number[] }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.CREATED;
}

export class TreasureStartedEvent extends DomainEvent<
  TreasureEventBase & { startedBy: string; threshold: number }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.STARTED;
}

export class TreasureProgressUpdatedEvent extends DomainEvent<
  TreasureEventBase & { progress: number; threshold: number; percent: number }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED;
}

export class TreasureRewardGeneratedEvent extends DomainEvent<
  TreasureEventBase & {
    strategy: string;
    poolAmount: number;
    /** What the pool was derived from — the level threshold. Audit only. */
    sourceAmount: number;
    winnerCount: number;
  }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.REWARD_GENERATED;
}

export class TreasureWinnerSelectedEvent extends DomainEvent<
  TreasureEventBase & {
    algorithm: string;
    /** Bumped when selection maths changes, so old draws stay explicable. */
    algorithmVersion: number;
    eligibleCount: number;
    candidateCount: number;
    winners: TreasureWinnerPayload[];
  }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.WINNER_SELECTED;
}

export class TreasureRewardDistributedEvent extends DomainEvent<
  TreasureEventBase & { userId: string; amount: number; walletTxnId: string | null }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED;
}

export class TreasureUnlockedEvent extends DomainEvent<
  TreasureEventBase & {
    poolAmount: number;
    winners: TreasureWinnerPayload[];
    algorithm: string;
    /** null when the ladder just completed — there is no next level. */
    nextLevel: number | null;
  }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED;
}

export class TreasureClosedEvent extends DomainEvent<
  TreasureEventBase & { status: string; closedBy: string | null }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.CLOSED;
}

export class TreasureRecoveredEvent extends DomainEvent<
  TreasureEventBase & { reason: 'DLQ_REPLAY' | 'ORPHAN_RECLAIM'; attempt: number }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.RECOVERED;
}

export class TreasureUnlockFailedEvent extends DomainEvent<
  TreasureEventBase & { stage: TreasureUnlockStage; attempt: number; error: string }
> {
  readonly name = VIDEO_ROOM_TREASURE_EVENTS.UNLOCK_FAILED;
}
