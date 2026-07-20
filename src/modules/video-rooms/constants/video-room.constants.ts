import { SOCKET_NAMESPACES } from 'src/common/constants/socket.constants';

/**
 * Video Room module constants: the socket namespace, client-facing
 * `video_room.*` event names, Redis key builders, and fixed numeric limits.
 * Config-driven values (participant/viewer caps, TTLs) live in the `videoRoom`
 * config namespace (see config/video-room.config.ts); these are the fixed
 * conventions shared across the repository/service/listener/monitor.
 */

/**
 * Socket.IO namespace the VideoRoomGateway serves. The gateway + namespace are
 * already declared in infra/socket — this module does NOT create them; it emits
 * into this namespace from its event-bus relay listener.
 */
export const VIDEO_ROOM_NAMESPACE: string = SOCKET_NAMESPACES.VIDEO_ROOM;

/**
 * Client-facing realtime event names broadcast into a video-room. Distinct from
 * the internal EVENT_BUS names in events/video-room.events.ts — the socket
 * listener maps bus event → one of these. The inbound spec events (joinRoom,
 * leaveRoom, heartbeat, reconnect) are served by the shared BaseGateway
 * (`room:join` / `room:leave` / `ping`) + the adapter's connectionStateRecovery,
 * so only the outbound events are named here.
 */
export const VIDEO_ROOM_SOCKET_EVENTS = {
  CREATED: 'video_room.created',
  UPDATED: 'video_room.updated',
  DELETED: 'video_room.deleted',
  CLOSED: 'video_room.closed',
  LOCKED: 'video_room.locked',
  OWNERSHIP_TRANSFERRED: 'video_room.ownership_transferred',
  USER_JOINED: 'video_room.user_joined',
  USER_LEFT: 'video_room.user_left',
  VIEWER_CONNECTED: 'video_room.viewer_connected',
  VIEWER_DISCONNECTED: 'video_room.viewer_disconnected',
  HOST_CONNECTED: 'video_room.host_connected',
  HOST_DISCONNECTED: 'video_room.host_disconnected',
  STREAM_READY: 'video_room.stream_ready',
  STREAM_CLOSED: 'video_room.stream_closed',
  STATE_SYNC: 'video_room.state_sync',
  // ---- VR-3 member/presence lifecycle ----
  USER_DISCONNECTED: 'video_room.user_disconnected',
  USER_RECONNECTED: 'video_room.user_reconnected',
  PRESENCE_UPDATED: 'video_room.presence_updated',
  /** Point-to-point (emitToUserEverywhere): tells the evicted socket to drop. */
  SESSION_EVICTED: 'video_room.session_evicted',
  // ---- VR-4 seat management (client-facing) ----
  SEAT_SYNC: 'video_room.seat_sync',
  SEAT_LOCKED: 'video_room.seat_locked',
  SEAT_UNLOCKED: 'video_room.seat_unlocked',
  SEAT_RESERVED: 'video_room.seat_reserved',
  SEAT_RELEASED: 'video_room.seat_released',
  SEAT_REQUESTED: 'video_room.seat_requested',
  SEAT_APPROVED: 'video_room.seat_approved',
  SEAT_REJECTED: 'video_room.seat_rejected',
  SEAT_INVITATION_SENT: 'video_room.seat_invitation_sent',
  SEAT_INVITATION_ACCEPTED: 'video_room.seat_invitation_accepted',
  SEAT_INVITATION_REJECTED: 'video_room.seat_invitation_rejected',
  SEAT_SWITCHED: 'video_room.seat_switched',
  SEAT_TRANSFERRED: 'video_room.seat_transferred',
  SEAT_UPDATED: 'video_room.seat_updated',
  // ---- VR-5 media engine (client-facing) ----
  MEDIA_JOINED: 'video_room.media_joined',
  MEDIA_LEFT: 'video_room.media_left',
  CAMERA_ON: 'video_room.camera_on',
  CAMERA_OFF: 'video_room.camera_off',
  MIC_ON: 'video_room.mic_on',
  MIC_OFF: 'video_room.mic_off',
  STREAM_PUBLISHED: 'video_room.stream_published',
  STREAM_STOPPED: 'video_room.stream_stopped',
  STREAM_PAUSED: 'video_room.stream_paused',
  STREAM_RESUMED: 'video_room.stream_resumed',
  MEDIA_SUBSCRIBED: 'video_room.subscribed',
  MEDIA_UNSUBSCRIBED: 'video_room.unsubscribed',
  BEAUTY_CHANGED: 'video_room.beauty_changed',
  QUALITY_CHANGED: 'video_room.quality_changed',
  AUDIO_OUTPUT_CHANGED: 'video_room.audio_output_changed',
  STREAM_STATE_CHANGED: 'video_room.stream_state_changed',
  MEDIA_RECOVERED: 'video_room.media_recovered',
  STREAM_FAILED: 'video_room.stream_failed',
  STREAM_RECOVERED: 'video_room.stream_recovered',
  MEDIA_STATE_SYNC: 'video_room.media_state_sync',
  // ---- VR-6 viewer mode (client-facing) ----
  VIEWER_PROMOTED: 'video_room.viewer_promoted',
  VIEWER_DEMOTED: 'video_room.viewer_demoted',
  VIEWER_PRESENCE_CHANGED: 'video_room.viewer_presence_changed',
} as const;

export type VideoRoomSocketEvent =
  (typeof VIDEO_ROOM_SOCKET_EVENTS)[keyof typeof VIDEO_ROOM_SOCKET_EVENTS];

// ---- Validation bounds (mirrored by the DTOs + validators) ----
export const VIDEO_ROOM_NAME_MIN = 3;
export const VIDEO_ROOM_NAME_MAX = 60;
export const VIDEO_ROOM_DESCRIPTION_MAX = 500;
export const VIDEO_ROOM_PASSWORD_MIN = 4;
export const VIDEO_ROOM_PASSWORD_MAX = 64;
export const VIDEO_ROOM_MIN_PARTICIPANTS = 2;
export const VIDEO_ROOM_MIN_VIEWERS = 0;

/** bcrypt cost factor for room passwords (independent of account password rounds). */
export const VIDEO_ROOM_PASSWORD_SALT_ROUNDS = 10;

// ---- Redis keys (single-key ops → Cluster-safe; hash-tag the room/socket id) ----

/** Cached room read snapshot (JSON) — read-through on GET /video-rooms/:id. */
export function videoRoomCacheKey(roomId: string): string {
  return `video-room:{${roomId}}:snapshot`;
}

/** Authoritative live room-state snapshot (versioned JSON) — VideoRoomStateService. */
export function videoRoomStateKey(roomId: string): string {
  return `video-room:{${roomId}}:state`;
}

/** Per-room lock serialising versioned state transitions. */
export function videoRoomStateLockKey(roomId: string): string {
  return `video-room:state:{${roomId}}`;
}

/** Set of live session socket ids in a room — VideoRoomSessionService. */
export function videoRoomSessionsKey(roomId: string): string {
  return `video-room:{${roomId}}:sessions`;
}

/** Per-socket session record (JSON) + heartbeat TTL — VideoRoomSessionService. */
export function videoRoomSessionKey(socketId: string): string {
  return `video-room:session:{${socketId}}`;
}

/**
 * Reverse index: a user's live session socket ids across rooms (VR-3). Makes
 * duplicate-session detection and the disconnect fast-path O(sessions-per-user)
 * instead of scanning a room's whole session set. Hash-tagged on the user id.
 */
export function videoRoomUserSessionsKey(userId: string): string {
  return `video-room:user:{${userId}}:sessions`;
}

/** Per-room join lock (VR-3): serialises capacity check + member/session writes. */
export function videoRoomJoinLockKey(roomId: string): string {
  return `video-room:join:{${roomId}}`;
}

/** Set of audience (viewer) user ids in a room — VideoRoomPresenceService. */
export function videoRoomViewersKey(roomId: string): string {
  return `video-room:{${roomId}}:viewers`;
}

/** Set of host user ids in a room — VideoRoomPresenceService. */
export function videoRoomHostsKey(roomId: string): string {
  return `video-room:{${roomId}}:hosts`;
}

/** Set of seat-holder (participant) user ids in a room — VideoRoomPresenceService. */
export function videoRoomParticipantsKey(roomId: string): string {
  return `video-room:{${roomId}}:participants`;
}

// ---- VR-4 seat management (single-key ops → Cluster-safe; hash-tag the room id) ----

/** Authoritative versioned seat snapshot (JSON) — VideoRoomSeatStateService. */
export function videoRoomSeatStateKey(roomId: string): string {
  return `video-room:{${roomId}}:seats`;
}

/** Per-room lock serialising all seat mutations (take/leave/lock/switch/transfer/…). */
export function videoRoomSeatLockKey(roomId: string): string {
  return `video-room:seat:{${roomId}}`;
}

/** Reservation hold with TTL → auto-released by the VideoRoomSeatMonitor sweep. */
export function videoRoomSeatReservationKey(roomId: string, seatIndex: number): string {
  return `video-room:{${roomId}}:seat:${seatIndex}:hold`;
}

/** Fleet-wide lock so exactly one instance runs the seat-expiry sweep. */
export const VIDEO_ROOM_SEAT_MONITOR_LOCK_KEY = 'video-room:seat:monitor';

/** Fleet-wide lock so exactly one instance runs the session-expiry sweep. */
export const VIDEO_ROOM_SESSION_MONITOR_LOCK_KEY = 'video-room:session:monitor';

// ---- VR-5 media engine (single-key ops → Cluster-safe; hash-tag the room id) ----

/** Authoritative versioned media snapshot (JSON) — VideoRoomMediaStateService. */
export function videoRoomMediaStateKey(roomId: string): string {
  return `video-room:{${roomId}}:media`;
}
/** Per-room lock serialising all media mutations (join/publish/camera/mic/…). */
export function videoRoomMediaLockKey(roomId: string): string {
  return `video-room:media:{${roomId}}`;
}
/** Per-publisher media liveness marker (TTL); absence ⇒ stale ⇒ monitor recovery. */
export function videoRoomMediaHeartbeatKey(roomId: string, userId: string): string {
  return `video-room:{${roomId}}:media:hb:${userId}`;
}
/** Recovery grant (token + TTL) during the reconnect grace window. */
export function videoRoomMediaRecoveryKey(roomId: string, userId: string): string {
  return `video-room:{${roomId}}:media:recovery:${userId}`;
}
/** Fleet-wide lock so exactly one instance runs the media-expiry sweep. */
export const VIDEO_ROOM_MEDIA_MONITOR_LOCK_KEY = 'video-room:media:monitor';

/**
 * Per-owner create lock (VR-2): serialises concurrent create requests from the
 * same owner so the "max rooms per owner" cap cannot be raced. Hash-tagged on the
 * owner id (single-key → Cluster-safe).
 */
export function videoRoomCreateLockKey(ownerId: string): string {
  return `video-room:create:{${ownerId}}`;
}

/**
 * Global trending sorted-set (VR-2 discovery). Seeded on create/activate, pruned
 * on close/delete. A single fleet-wide key (no hash-tag) — the only cross-room
 * Redis structure; every op on it is a single-key zset command (Cluster-safe).
 */
export const VIDEO_ROOM_TRENDING_KEY = 'video-room:trending';

// ---- BullMQ queues (VR-0 registers producers; workers land with their phases) ----

/**
 * The lean, purposeful queue set for the video-room domain. `MAIN` carries
 * general async work; `CLEANUP` carries idle/orphan-session sweeps. Analytics +
 * notifications reuse the central platform queues rather than duplicating them.
 */
export const VIDEO_ROOM_QUEUES = {
  MAIN: 'video-rooms',
  CLEANUP: 'video-rooms-cleanup',
} as const;

// ============================================================
// VR-1 — domain defaults & bounds (seat layout, requests, moderation).
// Fixed conventions shared across repositories/services. Room-instance overrides
// (e.g. a room's own seat counts) live in VideoRoomSettings; these are the
// platform defaults + the hard validation bounds.
// ============================================================

/** Default multi-seat video stage layout (VideoRoomSettings defaults mirror these). */
export const VIDEO_ROOM_DEFAULT_HOST_SEATS = 9;
export const VIDEO_ROOM_DEFAULT_GUEST_SEATS = 0;
/** Hard cap on total seats a room may configure (owner + hosts + guests). */
export const VIDEO_ROOM_MAX_SEATS = 20;
/** Seat index 0 is always the owner seat. */
export const VIDEO_ROOM_OWNER_SEAT_INDEX = 0;

/** TTL (seconds) after which a PENDING seat request auto-expires. */
export const VIDEO_ROOM_SEAT_REQUEST_TTL_SECONDS = 60;
/** TTL (seconds) after which a PENDING invitation auto-expires. */
export const VIDEO_ROOM_INVITATION_TTL_SECONDS = 120;

/** TTL (seconds) a seat reservation is held for its invitee before auto-release. */
export const VIDEO_ROOM_RESERVATION_TTL_SECONDS = 60;

/** Bounds for a moderation reason / announcement body. */
export const VIDEO_ROOM_MODERATION_REASON_MAX = 500;
export const VIDEO_ROOM_ANNOUNCEMENT_MAX = 1000;
/** Slow-mode ceiling (seconds between a viewer's chat messages). */
export const VIDEO_ROOM_SLOW_MODE_MAX_SECONDS = 3600;

/** Default page size + ceiling for paginated list/search repositories. */
export const VIDEO_ROOM_DEFAULT_PAGE_SIZE = 20;
export const VIDEO_ROOM_MAX_PAGE_SIZE = 100;
