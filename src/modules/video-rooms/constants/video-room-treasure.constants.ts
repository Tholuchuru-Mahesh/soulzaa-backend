/**
 * VR-11 treasure engine constants: the `/video-room` socket vocabulary, the
 * BullMQ job name, every Redis key the engine owns, and the closed vocabularies
 * for pool strategy, winner algorithm and pipeline stage.
 *
 * Per-room LOCK keys are hash-tagged `{roomId}` so Redis Cluster routes them to
 * a single slot (the AR-6 `treasureRoomLockKey` convention) — a Lua-based lock
 * release must not become a cross-slot operation. Plain data keys are NOT
 * hash-tagged: they are read individually, never in a multi-key command.
 */

/** The `TreasureSession.contextType` discriminator. Never spelled inline. */
export const TREASURE_CONTEXT_TYPE = 'VIDEO_ROOM';

/** Outbound socket events on the `/video-room` namespace. */
export const VIDEO_ROOM_TREASURE_SOCKET_EVENTS = {
  PROGRESS_UPDATED: 'treasureProgressUpdated',
  UNLOCKED: 'treasureUnlocked',
  WINNER_SELECTED: 'treasureWinnerSelected',
  REWARD_DISTRIBUTED: 'treasureRewardDistributed',
  LEVEL_CHANGED: 'treasureLevelChanged',
  ANIMATION: 'treasureAnimation',
  RECOVERED: 'treasureRecovered',
} as const;

/** BullMQ job name registered on QUEUE_NAMES.GIFT_PROCESSING. */
export const VIDEO_ROOM_TREASURE_QUEUE_JOB = 'video-room.treasure.unlock';

/** Serialises unlock execution per room so payouts and animations stay ordered. */
export function treasureUnlockLockKey(roomId: string): string {
  return `video-room:treasure:unlock:{${roomId}}`;
}

/** Serialises owner lifecycle commands per room. */
export function treasureLifecycleLockKey(roomId: string): string {
  return `video-room:treasure:lifecycle:{${roomId}}`;
}

/** Committed progress mirror for fast status reads. Postgres stays authoritative. */
export function treasureProgressKey(roomId: string): string {
  return `video-room:treasure:progress:${roomId}`;
}

/** Current accumulating level. */
export function treasureLevelKey(roomId: string): string {
  return `video-room:treasure:level:${roomId}`;
}

/** Per-user activity counter feeding the eligibility floor and ACTIVITY_BASED draws. */
export function treasureActivityKey(roomId: string, sessionId: string): string {
  return `video-room:treasure:activity:${roomId}:${sessionId}`;
}

/** Throttle stamp for `treasureProgressUpdated` coalescing. */
export function treasureEmitKey(roomId: string): string {
  return `video-room:treasure:emit:${roomId}`;
}

/** Temporary session statistics. */
export function treasureStatsKey(roomId: string, sessionId: string): string {
  return `video-room:treasure:stats:${roomId}:${sessionId}`;
}

/**
 * Cached `GET /treasure` view. Short-TTL read-through, invalidated whenever the
 * ladder moves (progress mirror, unlock, lifecycle transition) so a payout is
 * never hidden behind a stale snapshot.
 */
export function treasureStatusKey(roomId: string): string {
  return `video-room:treasure:status:${roomId}`;
}

/**
 * Where an unlock failed. Persisted on the reward row, attached to the failure
 * event and emitted as a metric label, so an operator attributes a failure to
 * validation vs eligibility vs the wallet without reading code.
 */
export const TreasureUnlockStage = {
  VALIDATE: 'VALIDATE',
  POOL: 'POOL',
  ELIGIBILITY: 'ELIGIBILITY',
  WINNER_SELECTION: 'WINNER_SELECTION',
  DISTRIBUTION: 'DISTRIBUTION',
  BROADCAST: 'BROADCAST',
  CHAIN: 'CHAIN',
  RECOVERY: 'RECOVERY',
} as const;
export type TreasureUnlockStage = (typeof TreasureUnlockStage)[keyof typeof TreasureUnlockStage];

/** How a box's reward pool is sized. */
export const TreasurePoolStrategy = {
  PERCENTAGE: 'PERCENTAGE',
  FIXED: 'FIXED',
  ADMIN_OVERRIDE: 'ADMIN_OVERRIDE',
} as const;
export type TreasurePoolStrategy = (typeof TreasurePoolStrategy)[keyof typeof TreasurePoolStrategy];

/** How winners are drawn from the eligible set. */
export const TreasureWinnerAlgorithm = {
  RANDOM: 'RANDOM',
  WEIGHTED_RANDOM: 'WEIGHTED_RANDOM',
  ACTIVITY_BASED: 'ACTIVITY_BASED',
  CONTRIBUTION_BASED: 'CONTRIBUTION_BASED',
  VIP_PRIORITY: 'VIP_PRIORITY',
} as const;
export type TreasureWinnerAlgorithm =
  (typeof TreasureWinnerAlgorithm)[keyof typeof TreasureWinnerAlgorithm];
