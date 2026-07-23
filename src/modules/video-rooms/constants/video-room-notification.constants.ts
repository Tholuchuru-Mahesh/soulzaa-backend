// src/modules/video-rooms/constants/video-room-notification.constants.ts
import type { NotificationType } from '@prisma/client';
import { PUSH_CATEGORIES, type PushCategory } from 'src/modules/device/interfaces/push.constants';
import type { PushPriority } from 'src/modules/device/interfaces/push-provider.interface';

/**
 * VR-15 notification matrix — the single source of truth for how a video-room
 * event is routed. Adding a notification type = adding a kind + a row here. Only
 * NEW-wired kinds live here; Gift Received / Follow are produced by existing
 * listeners (REUSE_EXISTING) and are deliberately absent, and purely in-room
 * socket events (treasure progress, pk started/ended, room lock/unlock, gift
 * sent) are owned by existing *-socket.listener.ts and are not dispatched here.
 */
export const VIDEO_ROOM_NOTIFICATION_KINDS = {
  ROOM_INVITATION: 'ROOM_INVITATION',
  SEAT_INVITATION: 'SEAT_INVITATION',
  SEAT_APPROVAL: 'SEAT_APPROVAL',
  SEAT_REJECTION: 'SEAT_REJECTION',
  VIEWER_PROMOTION: 'VIEWER_PROMOTION',
  VIEWER_DEMOTION: 'VIEWER_DEMOTION',
  TREASURE_UNLOCKED: 'TREASURE_UNLOCKED',
  TREASURE_REWARD: 'TREASURE_REWARD',
  PK_INVITATION: 'PK_INVITATION',
  PK_ACCEPTED: 'PK_ACCEPTED',
  PK_REJECTION: 'PK_REJECTION',
  PK_WINNER: 'PK_WINNER',
  ROOM_STARTED: 'ROOM_STARTED',
  ROOM_CLOSED: 'ROOM_CLOSED',
  ANNOUNCEMENT: 'ANNOUNCEMENT',
  MENTION: 'MENTION',
  SYSTEM: 'SYSTEM',
} as const;

export type VideoRoomNotificationKind =
  (typeof VIDEO_ROOM_NOTIFICATION_KINDS)[keyof typeof VIDEO_ROOM_NOTIFICATION_KINDS];

/** 4-level product severity; distinct from the device's 2-level PushPriority. */
export type NotificationSeverity = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';

/** Which preference boolean gates this kind (checked in the dispatcher). */
export type PreferenceToggle =
  | 'inviteEvents'
  | 'giftEvents'
  | 'systemEvents'
  | 'roomEvents'
  | 'seatEvents'
  | 'treasureEvents'
  | 'pkEvents'
  | 'announcementEvents';

export type NotificationAudience = 'TARGET' | 'ROOM_MEMBERS' | 'FOLLOWERS';

export interface MatrixCollapseCtx {
  roomId: string;
}

export interface MatrixRow {
  /** Durable-row enum value. All NEW kinds persist an in-app row. */
  notificationType: NotificationType;
  /** Coarse push category — reused, never a new Android channel. */
  pushCategory: PushCategory;
  severity: NotificationSeverity;
  channels: { inApp: boolean; socket: boolean; push: boolean };
  preferenceToggle: PreferenceToggle;
  audience: NotificationAudience;
  ttlSeconds?: number;
  /** undefined = never collapse (discrete/must-see). */
  collapseKey?: (ctx: MatrixCollapseCtx) => string | undefined;
}

/** HIGH/CRITICAL are wake-the-screen; everything else is normal. */
export function toPushPriority(severity: NotificationSeverity): PushPriority {
  return severity === 'HIGH' || severity === 'CRITICAL' ? 'high' : 'normal';
}

const roomState = (ctx: MatrixCollapseCtx) => `vr:${ctx.roomId}:state`;
const roomLive = (ctx: MatrixCollapseCtx) => `vr:${ctx.roomId}:live`;
const roomAnnouncement = (ctx: MatrixCollapseCtx) => `vr:${ctx.roomId}:announcement`;

const K = VIDEO_ROOM_NOTIFICATION_KINDS;

export const VIDEO_ROOM_NOTIFICATION_MATRIX: Record<VideoRoomNotificationKind, MatrixRow> = {
  [K.ROOM_INVITATION]: {
    notificationType: 'ROOM_INVITE',
    pushCategory: PUSH_CATEGORIES.INVITE,
    severity: 'HIGH',
    channels: { inApp: true, socket: true, push: true },
    preferenceToggle: 'inviteEvents',
    audience: 'TARGET',
    ttlSeconds: 120,
  },
  [K.SEAT_INVITATION]: {
    notificationType: 'SEAT_INVITE',
    pushCategory: PUSH_CATEGORIES.INVITE,
    severity: 'HIGH',
    channels: { inApp: true, socket: true, push: true },
    preferenceToggle: 'seatEvents',
    audience: 'TARGET',
    ttlSeconds: 120,
  },
  [K.SEAT_APPROVAL]: {
    notificationType: 'SEAT_APPROVED',
    pushCategory: PUSH_CATEGORIES.SYSTEM,
    severity: 'HIGH',
    channels: { inApp: true, socket: true, push: true },
    preferenceToggle: 'seatEvents',
    audience: 'TARGET',
  },
  [K.SEAT_REJECTION]: {
    notificationType: 'SEAT_REJECTED',
    pushCategory: PUSH_CATEGORIES.SYSTEM,
    severity: 'NORMAL',
    channels: { inApp: true, socket: true, push: false },
    preferenceToggle: 'seatEvents',
    audience: 'TARGET',
  },
  [K.VIEWER_PROMOTION]: {
    notificationType: 'VIEWER_PROMOTED',
    pushCategory: PUSH_CATEGORIES.SYSTEM,
    severity: 'HIGH',
    channels: { inApp: true, socket: true, push: true },
    preferenceToggle: 'roomEvents',
    audience: 'TARGET',
  },
  [K.VIEWER_DEMOTION]: {
    notificationType: 'VIEWER_DEMOTED',
    pushCategory: PUSH_CATEGORIES.SYSTEM,
    severity: 'NORMAL',
    channels: { inApp: true, socket: true, push: false },
    preferenceToggle: 'roomEvents',
    audience: 'TARGET',
  },
  [K.TREASURE_UNLOCKED]: {
    notificationType: 'TREASURE_UNLOCKED',
    pushCategory: PUSH_CATEGORIES.SYSTEM,
    severity: 'NORMAL',
    channels: { inApp: true, socket: true, push: true },
    preferenceToggle: 'treasureEvents',
    audience: 'ROOM_MEMBERS',
  },
  [K.TREASURE_REWARD]: {
    notificationType: 'TREASURE_REWARD',
    pushCategory: PUSH_CATEGORIES.GIFT,
    severity: 'HIGH',
    channels: { inApp: true, socket: true, push: true },
    preferenceToggle: 'treasureEvents',
    audience: 'TARGET',
  },
  [K.PK_INVITATION]: {
    notificationType: 'PK_INVITE',
    pushCategory: PUSH_CATEGORIES.INVITE,
    severity: 'HIGH',
    channels: { inApp: true, socket: true, push: true },
    preferenceToggle: 'pkEvents',
    audience: 'TARGET',
    ttlSeconds: 120,
  },
  [K.PK_ACCEPTED]: {
    notificationType: 'PK_ACCEPTED',
    pushCategory: PUSH_CATEGORIES.SYSTEM,
    severity: 'NORMAL',
    channels: { inApp: true, socket: true, push: false },
    preferenceToggle: 'pkEvents',
    audience: 'TARGET',
  },
  [K.PK_REJECTION]: {
    notificationType: 'PK_REJECTED',
    pushCategory: PUSH_CATEGORIES.SYSTEM,
    severity: 'NORMAL',
    channels: { inApp: true, socket: true, push: false },
    preferenceToggle: 'pkEvents',
    audience: 'TARGET',
  },
  [K.PK_WINNER]: {
    notificationType: 'PK_WINNER',
    pushCategory: PUSH_CATEGORIES.SYSTEM,
    severity: 'HIGH',
    channels: { inApp: true, socket: true, push: true },
    preferenceToggle: 'pkEvents',
    audience: 'TARGET',
  },
  [K.ROOM_STARTED]: {
    notificationType: 'ROOM_STARTED',
    pushCategory: PUSH_CATEGORIES.SYSTEM,
    severity: 'NORMAL',
    channels: { inApp: true, socket: false, push: true },
    preferenceToggle: 'roomEvents',
    audience: 'FOLLOWERS',
    collapseKey: roomLive,
  },
  [K.ROOM_CLOSED]: {
    notificationType: 'ROOM_CLOSED',
    pushCategory: PUSH_CATEGORIES.SYSTEM,
    severity: 'LOW',
    channels: { inApp: true, socket: true, push: false },
    preferenceToggle: 'roomEvents',
    audience: 'ROOM_MEMBERS',
    collapseKey: roomState,
  },
  [K.ANNOUNCEMENT]: {
    notificationType: 'ANNOUNCEMENT',
    pushCategory: PUSH_CATEGORIES.SYSTEM,
    severity: 'NORMAL',
    channels: { inApp: true, socket: true, push: true },
    preferenceToggle: 'announcementEvents',
    audience: 'ROOM_MEMBERS',
    collapseKey: roomAnnouncement,
  },
  [K.MENTION]: {
    notificationType: 'MENTION',
    pushCategory: PUSH_CATEGORIES.SYSTEM,
    severity: 'HIGH',
    channels: { inApp: true, socket: true, push: true },
    preferenceToggle: 'roomEvents',
    audience: 'TARGET',
  },
  [K.SYSTEM]: {
    notificationType: 'SYSTEM',
    pushCategory: PUSH_CATEGORIES.SYSTEM,
    severity: 'NORMAL',
    channels: { inApp: true, socket: true, push: true },
    preferenceToggle: 'systemEvents',
    audience: 'TARGET',
  },
};

/** Fan-out recipient source discriminator carried on the fan-out job. */
export type FanoutSource = 'FOLLOWERS' | 'MEMBERS';

/**
 * Above this active-member count, ROOM_MEMBERS delivery is fanned out to the
 * notifications worker instead of running inline on the awaited event bus (which
 * would block the triggering request on N sequential deliveries). At/below it,
 * small rooms deliver inline (immediate, no queue hop).
 */
export const VIDEO_ROOM_NOTIFICATION_MEMBER_FANOUT_THRESHOLD = 50;

/** Tunable fan-out chunk size — see §7.1. Config override key resolves first. */
export const VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_SIZE = 500;
export const VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_BOUNDS = { min: 100, max: 2000 } as const;
export const VIDEO_ROOM_NOTIFICATION_FANOUT_CONFIG_KEY = 'videoRoom.notificationFanoutChunkSize';

/** BullMQ job name registered on the existing `notifications` queue. */
export const VIDEO_ROOM_NOTIFICATION_FANOUT_JOB = 'video-room.notification.fanout';

/** In-room live banner socket events on the /video-room namespace. */
export const VIDEO_ROOM_NOTIFICATION_SOCKET_EVENTS = {
  ROOM_NOTIFICATION: 'roomNotification',
  ANNOUNCEMENT: 'announcement',
} as const;

/** Redis set tracking already-delivered recipients for one fan-out occurrence. */
export const videoRoomFanoutSentKey = (occurrenceId: string): string =>
  `video-room:notif:fanout:${occurrenceId}:sent`;

/** Redis set of roomIds a user has muted notifications for. */
export const videoRoomNotificationMuteKey = (userId: string): string =>
  `video-room:notif:mute:${userId}`;
