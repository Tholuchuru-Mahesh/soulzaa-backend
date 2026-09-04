import { VideoRoomVisibility } from '@prisma/client';
import { DomainEvent } from 'src/common/events';
import type { VideoRoomPresenceState } from '../enums';
import type { VideoRoomSettingsView } from '../entities/video-room-detail.view';

/** Why a member's connection dropped (UserDisconnectedEvent). */
export type VideoRoomDisconnectReason = 'duplicate_session' | 'connection_lost' | 'timeout';

/**
 * Video-room lifecycle events on the EVENT_BUS. The module's own socket listener
 * consumes these to broadcast `video_room.*` to the `/video-room` namespace;
 * later domains (analytics, notifications, rankings) subscribe to the same events
 * without importing this module. Payloads are serialisable id-carrying records so
 * the transport can move in-process → Redis/Kafka unchanged.
 *
 * VR-0 (foundation) DEFINES and can PUBLISH these; the only consumer is the
 * transport relay (VideoRoomSocketListener). Business/queue consumers arrive with
 * their phases.
 */
export const VIDEO_ROOM_EVENTS = {
  CREATED: 'video_room.created',
  UPDATED: 'video_room.updated',
  SETTINGS_UPDATED: 'video_room.settings_updated',
  DELETED: 'video_room.deleted',
  GIFT_LOCK_ENABLED: 'video_room.gift_lock_enabled',
  GIFT_LOCK_DISABLED: 'video_room.gift_lock_disabled',
  RESTORED: 'video_room.restored',
  CLOSED: 'video_room.closed',
  USER_JOINED: 'video_room.user_joined',
  USER_LEFT: 'video_room.user_left',
  VIEWER_JOINED: 'video_room.viewer_joined',
  VIEWER_LEFT: 'video_room.viewer_left',
  HOST_CONNECTED: 'video_room.host_connected',
  HOST_DISCONNECTED: 'video_room.host_disconnected',
  STREAM_STARTED: 'video_room.stream_started',
  STREAM_STOPPED: 'video_room.stream_stopped',
  // ---- VR-3 member/presence/session lifecycle ----
  USER_DISCONNECTED: 'video_room.user_disconnected',
  USER_RECONNECTED: 'video_room.user_reconnected',
  PRESENCE_UPDATED: 'video_room.presence_updated',
  HEARTBEAT_MISSED: 'video_room.heartbeat_missed',
  SESSION_CREATED: 'video_room.session_created',
  SESSION_EXPIRED: 'video_room.session_expired',
  ROOM_SYNCHRONIZED: 'video_room.room_synchronized',
  // ---- VR-6 viewer mode ----
  VIEWER_PROMOTED: 'video_room.viewer_promoted',
  VIEWER_DEMOTED: 'video_room.viewer_demoted',
  VIEWER_PRESENCE_CHANGED: 'video_room.viewer_presence_changed',
  // ---- VR-15 notifications ----
  STARTED: 'video_room.started',
} as const;

export class RoomCreatedEvent extends DomainEvent<{
  roomId: string;
  ownerId: string;
  name: string;
  categoryId: string | null;
  language: string | null;
  visibility: VideoRoomVisibility;
}> {
  readonly name = VIDEO_ROOM_EVENTS.CREATED;
}

export class RoomClosedEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
  ownerId: string;
  durationSeconds: number;
}> {
  readonly name = VIDEO_ROOM_EVENTS.CLOSED;
}

/** A room went LIVE (OFFLINE→LIVE). Drives the followers "X is live" fan-out. */
export class RoomStartedEvent extends DomainEvent<{
  roomId: string;
  ownerId: string;
  actorId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.STARTED;
}

/** A room's mutable fields / settings / access policy changed (VR-2). */
export class RoomUpdatedEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
  changed: string[];
}> {
  readonly name = VIDEO_ROOM_EVENTS.UPDATED;
}

/**
 * VR-17 — a room's configurable settings changed. `settings` is the FULL
 * post-write snapshot (not a delta) so clients replace wholesale, which makes
 * reconciliation idempotent and removes ordering hazards between concurrent
 * admin edits. `changed` lists the keys the patch actually touched, for audit
 * and for clients that want to animate only what moved.
 */
export class RoomSettingsUpdatedEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
  changed: string[];
  settings: VideoRoomSettingsView;
}> {
  readonly name = VIDEO_ROOM_EVENTS.SETTINGS_UPDATED;
}

/** A room was soft-deleted (VR-2). History retained; live viewers evicted. */
export class RoomDeletedEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
  ownerId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.DELETED;
}

/** A room's gift-lock was enabled with the given required gift (new lock feature). */
export class GiftLockEnabledEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
  giftId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.GIFT_LOCK_ENABLED;
}

/** A room's gift-lock was disabled. */
export class GiftLockDisabledEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.GIFT_LOCK_DISABLED;
}

/** A soft-deleted room was restored (VR-2). */
export class RoomRestoredEvent extends DomainEvent<{
  roomId: string;
  actorId: string;
  ownerId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.RESTORED;
}

export class UserJoinedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  username?: string;
  name?: string;
  avatarUrl?: string;
  participantCount: number;
}> {
  readonly name = VIDEO_ROOM_EVENTS.USER_JOINED;
}

export class UserLeftEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  participantCount: number;
}> {
  readonly name = VIDEO_ROOM_EVENTS.USER_LEFT;
}

export class ViewerJoinedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  viewerCount: number;
}> {
  readonly name = VIDEO_ROOM_EVENTS.VIEWER_JOINED;
}

export class ViewerLeftEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  viewerCount: number;
}> {
  readonly name = VIDEO_ROOM_EVENTS.VIEWER_LEFT;
}

export class HostConnectedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.HOST_CONNECTED;
}

export class HostDisconnectedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.HOST_DISCONNECTED;
}

export class StreamStartedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  mediaRoomId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.STREAM_STARTED;
}

export class StreamStoppedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.STREAM_STOPPED;
}

// ---- VR-3 member/presence/session lifecycle ----

/** A member's connection dropped (duplicate eviction, socket loss, or timeout). */
export class UserDisconnectedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  socketId: string;
  reason: VideoRoomDisconnectReason;
}> {
  readonly name = VIDEO_ROOM_EVENTS.USER_DISCONNECTED;
}

/** A member re-established their connection within the grace window. */
export class UserReconnectedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  socketId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.USER_RECONNECTED;
}

/** A member's presence state changed (coalesced — published only on transition). */
export class PresenceUpdatedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  state: VideoRoomPresenceState;
  onlineCount: number;
  reconnectingCount: number;
  idleCount: number;
}> {
  readonly name = VIDEO_ROOM_EVENTS.PRESENCE_UPDATED;
}

/** A session crossed the heartbeat-miss threshold (bus-only; monitoring). */
export class HeartbeatMissedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  socketId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.HEARTBEAT_MISSED;
}

/** A session was created on join (bus-only; analytics). */
export class SessionCreatedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  socketId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.SESSION_CREATED;
}

/** A session ended (clean leave or grace-window reclaim) (bus-only; analytics). */
export class SessionExpiredEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  socketId: string;
  durationSeconds: number;
}> {
  readonly name = VIDEO_ROOM_EVENTS.SESSION_EXPIRED;
}

/** A client (re)synchronised the room state (version-based). */
export class RoomSynchronizedEvent extends DomainEvent<{
  roomId: string;
  version: number;
}> {
  readonly name = VIDEO_ROOM_EVENTS.ROOM_SYNCHRONIZED;
}
