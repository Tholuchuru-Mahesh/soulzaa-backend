import {
  VideoRoomModerationActionType,
  VideoRoomModerationMuteType,
  VideoRoomReportReason,
  VideoRoomReportStatus,
} from '@prisma/client';
import { DomainEvent } from 'src/common/events';
import type { MuteChannel } from '../dto/moderation.dto';

/**
 * Video-room moderation domain events on the EVENT_BUS (VR-16). The
 * moderation socket listener bridges the room-facing ones to
 * `video-room-moderation.constants.ts`'s flat `VIDEO_ROOM_MODERATION_SOCKET_EVENTS`
 * broadcasts; `UserReportedEvent`/`ReportReviewedEvent` are delivered to
 * moderators only (never broadcast to the room). Analytics/notifications/the
 * automated-moderation listener subscribe to these without importing this
 * module. Mirrors `audio-room-moderation.events.ts`'s registry + class
 * pattern, but drops the audio-only ban/appeal concepts (the Video Room has
 * no ban — `VideoRoomBlock`/"blacklist" is the only bar-from-room primitive)
 * and adds `UserForceDisconnectedEvent`, `ReportReviewedEvent`,
 * `RoomModerationUpdatedEvent`, and the generic
 * `ModerationActionCompletedEvent` (fired alongside every specific event as
 * a single audit/metrics/history-invalidation fan-out point — it has no
 * dedicated socket broadcast of its own).
 */
export const VIDEO_ROOM_MODERATION_EVENTS = {
  KICKED: 'video_room.user_kicked',
  BLACKLISTED: 'video_room.user_blacklisted',
  UNBLACKLISTED: 'video_room.user_unblacklisted',
  MUTED: 'video_room.user_muted',
  UNMUTED: 'video_room.user_unmuted',
  WARNED: 'video_room.user_warned',
  FORCE_DISCONNECTED: 'video_room.user_force_disconnected',
  REPORTED: 'video_room.user_reported',
  REPORT_REVIEWED: 'video_room.report_reviewed',
  ROOM_MODERATION_UPDATED: 'video_room.room_moderation_updated',
  ACTION_COMPLETED: 'video_room.moderation_action_completed',
} as const;

export type VideoRoomModerationEvent =
  (typeof VIDEO_ROOM_MODERATION_EVENTS)[keyof typeof VIDEO_ROOM_MODERATION_EVENTS];

/** Fields every actor-targeted moderation event payload carries. */
interface ModerationEventBase {
  roomId: string;
  moderatorId: string;
  targetUserId: string;
}

export class UserKickedEvent extends DomainEvent<ModerationEventBase & { reason: string | null }> {
  readonly name = VIDEO_ROOM_MODERATION_EVENTS.KICKED;
}

export class UserBlacklistedEvent extends DomainEvent<
  ModerationEventBase & { reason: string | null }
> {
  readonly name = VIDEO_ROOM_MODERATION_EVENTS.BLACKLISTED;
}

/** A moderator restored a blacklisted user: they may rejoin the room. */
export class UserUnblacklistedEvent extends DomainEvent<ModerationEventBase> {
  readonly name = VIDEO_ROOM_MODERATION_EVENTS.UNBLACKLISTED;
}

export class UserMutedEvent extends DomainEvent<
  ModerationEventBase & {
    type: VideoRoomModerationMuteType;
    reason: string | null;
    expiresAt: string | null;
    channels: MuteChannel[];
  }
> {
  readonly name = VIDEO_ROOM_MODERATION_EVENTS.MUTED;
}

export class UserUnmutedEvent extends DomainEvent<
  ModerationEventBase & { channels: MuteChannel[]; reason: 'lifted' | 'expired' }
> {
  readonly name = VIDEO_ROOM_MODERATION_EVENTS.UNMUTED;
}

export class UserWarnedEvent extends DomainEvent<
  ModerationEventBase & { reason: string; metadata: Record<string, unknown> | null }
> {
  readonly name = VIDEO_ROOM_MODERATION_EVENTS.WARNED;
}

/** A transient eject: no durable mute/block, no membership deactivation. */
export class UserForceDisconnectedEvent extends DomainEvent<
  ModerationEventBase & { reason: string | null }
> {
  readonly name = VIDEO_ROOM_MODERATION_EVENTS.FORCE_DISCONNECTED;
}

export class UserReportedEvent extends DomainEvent<{
  roomId: string;
  reportId: string;
  reporterId: string;
  targetUserId: string;
  reason: VideoRoomReportReason;
  /** Users who should be notified of the report (elevated roles + owner, minus reporter). */
  recipientIds: string[];
}> {
  readonly name = VIDEO_ROOM_MODERATION_EVENTS.REPORTED;
}

export class ReportReviewedEvent extends DomainEvent<{
  roomId: string;
  reportId: string;
  moderatorId: string;
  targetUserId: string;
  status: VideoRoomReportStatus;
  resolutionAction: string | null;
}> {
  readonly name = VIDEO_ROOM_MODERATION_EVENTS.REPORT_REVIEWED;
}

/** Room-wide moderation config change (e.g. `muteAll`) — no single target user. */
export class RoomModerationUpdatedEvent extends DomainEvent<{
  roomId: string;
  moderatorId: string;
  channels: MuteChannel[];
  muted: boolean;
}> {
  readonly name = VIDEO_ROOM_MODERATION_EVENTS.ROOM_MODERATION_UPDATED;
}

/**
 * Generic "a moderation action was recorded" signal, published alongside
 * every specific event above. `moderatorId`/`targetUserId` are nullable to
 * cover the auto-moderation (`SYSTEM_MODERATOR_ID`) and room-wide
 * (no single target) cases. Not bridged to a room broadcast — consumed by
 * cross-cutting concerns (metrics, moderation-history invalidation) that
 * don't need to special-case every action type.
 */
export class ModerationActionCompletedEvent extends DomainEvent<{
  roomId: string;
  moderatorId: string | null;
  targetUserId: string | null;
  action: VideoRoomModerationActionType;
  reason: string | null;
  metadata: Record<string, unknown> | null;
}> {
  readonly name = VIDEO_ROOM_MODERATION_EVENTS.ACTION_COMPLETED;
}
