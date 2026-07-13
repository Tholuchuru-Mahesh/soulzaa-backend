import { ModerationBanType, ModerationMuteType, ReportReason } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * Audio-room moderation events on the EVENT_BUS. The moderation socket listener
 * bridges the room-facing ones to `room.*`/`member.*` broadcasts; report/appeal
 * events are delivered to moderators (not broadcast). Analytics/notifications
 * subscribe to the same events without importing this module.
 */
export const AUDIO_ROOM_MODERATION_EVENTS = {
  KICKED: 'audio_room.member_kicked',
  UNKICKED: 'audio_room.member_unkicked',
  BANNED: 'audio_room.member_banned',
  UNBANNED: 'audio_room.member_unbanned',
  MUTED: 'audio_room.member_muted',
  UNMUTED: 'audio_room.member_unmuted',
  WARNED: 'audio_room.member_warned',
  REPORTED: 'audio_room.member_reported',
  APPEAL_SUBMITTED: 'audio_room.appeal_submitted',
  APPEAL_RESOLVED: 'audio_room.appeal_resolved',
} as const;

export class MemberKickedEvent extends DomainEvent<{
  roomId: string;
  moderatorId: string;
  targetUserId: string;
  reason: string | null;
}> {
  readonly name = AUDIO_ROOM_MODERATION_EVENTS.KICKED;
}

/** A moderator restored a kicked user: they leave the Kick List and may rejoin. */
export class MemberUnkickedEvent extends DomainEvent<{
  roomId: string;
  moderatorId: string;
  targetUserId: string;
  kickId: string;
}> {
  readonly name = AUDIO_ROOM_MODERATION_EVENTS.UNKICKED;
}

export class MemberBannedEvent extends DomainEvent<{
  roomId: string;
  moderatorId: string;
  targetUserId: string;
  type: ModerationBanType;
  reason: string | null;
  expiresAt: string | null;
}> {
  readonly name = AUDIO_ROOM_MODERATION_EVENTS.BANNED;
}

export class MemberUnbannedEvent extends DomainEvent<{
  roomId: string;
  moderatorId: string;
  targetUserId: string;
  reason: 'lifted' | 'expired' | 'appeal_approved';
}> {
  readonly name = AUDIO_ROOM_MODERATION_EVENTS.UNBANNED;
}

export class MemberMutedEvent extends DomainEvent<{
  roomId: string;
  moderatorId: string;
  targetUserId: string;
  type: ModerationMuteType;
  reason: string | null;
  expiresAt: string | null;
}> {
  readonly name = AUDIO_ROOM_MODERATION_EVENTS.MUTED;
}

export class MemberUnmutedEvent extends DomainEvent<{
  roomId: string;
  moderatorId: string;
  targetUserId: string;
  reason: 'lifted' | 'expired' | 'appeal_approved';
}> {
  readonly name = AUDIO_ROOM_MODERATION_EVENTS.UNMUTED;
}

export class MemberWarnedEvent extends DomainEvent<{
  roomId: string;
  moderatorId: string;
  targetUserId: string;
  reason: string;
}> {
  readonly name = AUDIO_ROOM_MODERATION_EVENTS.WARNED;
}

export class MemberReportedEvent extends DomainEvent<{
  roomId: string;
  reportId: string;
  reporterId: string;
  targetUserId: string;
  reason: ReportReason;
  /** Users who should be notified of the report (owner + room admins). */
  recipientIds: string[];
}> {
  readonly name = AUDIO_ROOM_MODERATION_EVENTS.REPORTED;
}

export class AppealSubmittedEvent extends DomainEvent<{
  roomId: string;
  appealId: string;
  userId: string;
  recipientIds: string[];
}> {
  readonly name = AUDIO_ROOM_MODERATION_EVENTS.APPEAL_SUBMITTED;
}

export class AppealResolvedEvent extends DomainEvent<{
  roomId: string;
  appealId: string;
  userId: string;
  approved: boolean;
}> {
  readonly name = AUDIO_ROOM_MODERATION_EVENTS.APPEAL_RESOLVED;
}
