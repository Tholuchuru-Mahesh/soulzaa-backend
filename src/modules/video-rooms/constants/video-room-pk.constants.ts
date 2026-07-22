import { VideoRoomPkStatus } from '@prisma/client';

/**
 * VR-12 PK engine constants: the `/video-room` socket vocabulary, the BullMQ job
 * names, every Redis key the engine owns, and the validated state machine.
 *
 * Per-room LOCK keys are hash-tagged `{roomId}` so Redis Cluster routes them to a
 * single slot (the VR-11 convention) — a Lua-based lock release must not become a
 * cross-slot operation. Plain data keys are NOT hash-tagged: they are read
 * individually, never in a multi-key command.
 */

/** Outbound socket events on the `/video-room` namespace. */
export const VIDEO_ROOM_PK_SOCKET_EVENTS = {
  INVITATION_SENT: 'pkInvitationSent',
  INVITATION_ACCEPTED: 'pkInvitationAccepted',
  INVITATION_REJECTED: 'pkInvitationRejected',
  STARTED: 'pkStarted',
  COUNTDOWN: 'pkCountdown',
  SCORE_UPDATED: 'pkScoreUpdated',
  PAUSED: 'pkPaused',
  RESUMED: 'pkResumed',
  ENDED: 'pkEnded',
  WINNER: 'pkWinner',
  RECOVERED: 'pkRecovered',
} as const;

/** BullMQ job names registered on QUEUE_NAMES.GIFT_PROCESSING. */
export const VIDEO_ROOM_PK_START_JOB = 'video-room.pk.start';
export const VIDEO_ROOM_PK_END_JOB = 'video-room.pk.end';

/** Serialises lifecycle commands per room. */
export function pkLifecycleLockKey(roomId: string): string {
  return `video-room:pk:lifecycle:{${roomId}}`;
}

/** Fleet-wide sweep lock: many pods, one sweeper. */
export const PK_RECOVERY_LOCK_KEY = 'video-room:pk:recovery';

/** Live scoreboard mirror: HASH { RED, BLUE, giftCount, baseTotal }. */
export function pkScoreKey(battleId: string): string {
  return `video-room:pk:score:${battleId}`;
}

/** Throttle stamp for `pkScoreUpdated` coalescing. */
export function pkEmitKey(battleId: string): string {
  return `video-room:pk:emit:${battleId}`;
}

/** Multiplier base. 10 000 bps = 1.0×. Bonuses ADD to this, they do not multiply. */
export const PK_MULTIPLIER_BASE_BPS = 10_000;

export const PK_TERMINAL_STATUSES: readonly VideoRoomPkStatus[] = [
  VideoRoomPkStatus.COMPLETED,
  VideoRoomPkStatus.CANCELLED,
  VideoRoomPkStatus.FAILED,
];

export function isPkTerminal(status: VideoRoomPkStatus): boolean {
  return PK_TERMINAL_STATUSES.includes(status);
}

const S = VideoRoomPkStatus;

/**
 * The validated state machine — the single source of truth for what may follow
 * what. Every persisted transition ALSO runs as a conditional UPDATE
 * (`WHERE status = $from`), so this table and the database agree; the table
 * gives a clean domain error, the UPDATE wins the race.
 *
 * CANCELLED and FAILED are reachable from every non-terminal state; terminal
 * states are dead ends, which is what makes settlement replay-safe.
 */
export const VIDEO_ROOM_PK_TRANSITIONS: Record<
  VideoRoomPkStatus,
  ReadonlySet<VideoRoomPkStatus>
> = {
  [S.CREATED]: new Set([S.INVITED, S.CANCELLED, S.FAILED]),
  [S.INVITED]: new Set([S.PENDING, S.ACCEPTED, S.CANCELLED, S.FAILED]),
  [S.PENDING]: new Set([S.ACCEPTED, S.CANCELLED, S.FAILED]),
  [S.ACCEPTED]: new Set([S.COUNTDOWN, S.CANCELLED, S.FAILED]),
  [S.COUNTDOWN]: new Set([S.LIVE, S.CANCELLED, S.FAILED]),
  [S.LIVE]: new Set([S.PAUSED, S.RECOVERING, S.COMPLETED, S.CANCELLED, S.FAILED]),
  [S.PAUSED]: new Set([S.LIVE, S.COMPLETED, S.CANCELLED, S.FAILED]),
  [S.RECOVERING]: new Set([S.LIVE, S.COMPLETED, S.CANCELLED, S.FAILED]),
  [S.COMPLETED]: new Set<VideoRoomPkStatus>(),
  [S.CANCELLED]: new Set<VideoRoomPkStatus>(),
  [S.FAILED]: new Set<VideoRoomPkStatus>(),
};
