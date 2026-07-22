import { DomainEvent } from 'src/common/events';

/**
 * VR-12 PK events owned by the video-rooms module.
 *
 * All 12 are NEW names under `video_room.pk.*`. The audio module's
 * `audio_room.pk.*` events are untouched and are NOT re-published here —
 * doing so would fire every audio listener for a video battle.
 */
export const VIDEO_ROOM_PK_EVENTS = {
  INVITATION_SENT: 'video_room.pk.invitation_sent',
  INVITATION_ACCEPTED: 'video_room.pk.invitation_accepted',
  INVITATION_REJECTED: 'video_room.pk.invitation_rejected',
  CREATED: 'video_room.pk.created',
  STARTED: 'video_room.pk.started',
  SCORE_UPDATED: 'video_room.pk.score_updated',
  PAUSED: 'video_room.pk.paused',
  RESUMED: 'video_room.pk.resumed',
  ENDED: 'video_room.pk.ended',
  WINNER_DECLARED: 'video_room.pk.winner_declared',
  REWARD_DISTRIBUTED: 'video_room.pk.reward_distributed',
  RECOVERED: 'video_room.pk.recovered',
} as const;

/** Every PK payload is addressable by (roomId, battleId). */
export interface PkEventBase {
  roomId: string;
  battleId: string;
  /**
   * The originating HTTP request id, when the command that caused this event
   * came from a request (Task 17's lifecycle service threads one through
   * every command it accepts). Optional so no existing construction breaks:
   * commands with no request context (queue jobs, the recovery sweep) simply
   * omit it, and the Task 23 audit listener records `null` rather than
   * guessing.
   */
  requestId?: string;
}

/** Side totals as broadcast. Numbers, not BigInt — this crosses the wire. */
export interface PkTeamView {
  teamId: string;
  side: string;
  score: number;
}

export class PkInvitationSentEvent extends DomainEvent<
  PkEventBase & {
    invitationId: string;
    inviteeUserId: string;
    inviterUserId: string;
    side: string;
    attempt: number;
    expiresAt: string;
  }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.INVITATION_SENT;
}

export class PkInvitationAcceptedEvent extends DomainEvent<
  PkEventBase & { invitationId: string; inviteeUserId: string }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.INVITATION_ACCEPTED;
}

export class PkInvitationRejectedEvent extends DomainEvent<
  PkEventBase & { invitationId: string; inviteeUserId: string }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.INVITATION_REJECTED;
}

export class PkCreatedEvent extends DomainEvent<
  PkEventBase & { mode: string; createdBy: string; durationSeconds: number }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.CREATED;
}

export class PkStartedEvent extends DomainEvent<
  PkEventBase & {
    mode: string;
    countdownSeconds: number;
    durationSeconds: number;
    startedAt: string;
    endsAt: string;
    teams: PkTeamView[];
    participants: { userId: string; side: string; teamId: string }[];
  }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.STARTED;
}

export class PkScoreUpdatedEvent extends DomainEvent<
  PkEventBase & {
    side: string;
    teams: PkTeamView[];
    participantId: string;
    userId: string;
    scoredAmount: number;
    multiplierBps: number;
  }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.SCORE_UPDATED;
}

export class PkPausedEvent extends DomainEvent<
  PkEventBase & { pausedAt: string; remainingMs: number; involuntary: boolean }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.PAUSED;
}

export class PkResumedEvent extends DomainEvent<
  PkEventBase & { resumedAt: string; endsAt: string; resumeSeq: number }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.RESUMED;
}

export class PkEndedEvent extends DomainEvent<
  PkEventBase & {
    winningTeamId: string | null;
    isDraw: boolean;
    teams: PkTeamView[];
    durationSeconds: number;
    giftCount: number;
    totalBase: number;
  }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.ENDED;
}

export class PkWinnerDeclaredEvent extends DomainEvent<
  PkEventBase & { winningTeamId: string | null; isDraw: boolean; winners: string[] }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.WINNER_DECLARED;
}

export class PkRewardDistributedEvent extends DomainEvent<
  PkEventBase & {
    poolAmount: number;
    allocatedAmount: number;
    rewards: { userId: string; kind: string; amount: number }[];
  }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED;
}

export class PkRecoveredEvent extends DomainEvent<
  PkEventBase & { reason: string; previousStatus: string; newStatus: string }
> {
  readonly name = VIDEO_ROOM_PK_EVENTS.RECOVERED;
}
