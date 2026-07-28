import type { PkMode, PkResult, PkSide } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * AR-10 PK-battle events. The PK socket listener bridges these to the
 * `/audio-room` namespace so participants see the battle start, live score
 * ticks, and the result/winner animation in realtime.
 */
export const AUDIO_ROOM_PK_EVENTS = {
  STARTED: 'audio_room.pk_started',
  SCORE: 'audio_room.pk_score',
  ENDED: 'audio_room.pk_ended',
  CANCELLED: 'audio_room.pk_cancelled',
  INVITED: 'audio_room.pk_invited',
  REJECTED: 'audio_room.pk_rejected',
  RECEIVER_BONUS: 'audio_room.pk_receiver_bonus',
} as const;

export interface PkParticipantView {
  userId: string;
  side: PkSide;
  score: number;
}

export class PkStartedEvent extends DomainEvent<{
  roomId: string;
  battleId: string;
  mode: PkMode;
  durationSeconds: number;
  endsAt: string;
  participants: PkParticipantView[];
}> {
  readonly name = AUDIO_ROOM_PK_EVENTS.STARTED;
}

export class PkScoreEvent extends DomainEvent<{
  roomId: string;
  battleId: string;
  redScore: number;
  blueScore: number;
  side: PkSide;
  userId: string;
  participantScore: number;
}> {
  readonly name = AUDIO_ROOM_PK_EVENTS.SCORE;
}

export class PkEndedEvent extends DomainEvent<{
  roomId: string;
  battleId: string;
  result: PkResult;
  redScore: number;
  blueScore: number;
  winners: string[];
}> {
  readonly name = AUDIO_ROOM_PK_EVENTS.ENDED;
}

export class PkCancelledEvent extends DomainEvent<{
  roomId: string;
  battleId: string;
}> {
  readonly name = AUDIO_ROOM_PK_EVENTS.CANCELLED;
}

export class PkInvitedEvent extends DomainEvent<{
  roomId: string;
  mode: PkMode;
  durationSeconds: number;
  red: string[];
  blue: string[];
  targetUserId: string;
  inviterId: string;
  inviterName: string;
}> {
  readonly name = AUDIO_ROOM_PK_EVENTS.INVITED;
}

export class PkRejectedEvent extends DomainEvent<{
  roomId: string;
  targetUserId: string;
  inviterId: string;
}> {
  readonly name = AUDIO_ROOM_PK_EVENTS.REJECTED;
}

export class PkReceiverBonusEvent extends DomainEvent<{
  roomId: string;
  battleId: string;
  senderId: string;
  receiverId: string;
  giftId: string;
  originalGiftValue: number;
  bonusCoins: number;
  walletTxnId: string;
}> {
  readonly name = AUDIO_ROOM_PK_EVENTS.RECEIVER_BONUS;
}
