import type { VideoRoomPresence } from '@prisma/client';
import type { ConnectionType, VideoRoomPresenceState } from '../enums';

/** Inputs to register a new client session (one per socket). */
export interface RegisterSessionInput {
  roomId: string;
  userId: string;
  socketId: string;
  role: ConnectionType;
  /** Device the socket runs on — the (userId, deviceId) duplicate-session key. */
  deviceId?: string;
  /** Client platform (ios/android/web) — audit only. */
  platform?: string;
  /** Client IP — audit only. */
  ip?: string;
  /** Auth session id (AuthenticatedUser.sid) — audit only. */
  sid?: string;
}

/** A registered session as stored in the session registry. */
export interface VideoRoomSessionRecord {
  roomId: string;
  userId: string;
  socketId: string;
  role: ConnectionType;
  deviceId?: string;
  platform?: string;
  ip?: string;
  sid?: string;
  /** Last computed/observed presence state (the sticky terminals live here). */
  presenceState: VideoRoomPresenceState;
  /** Client-reported activity flag — drives IDLE. */
  inBackground: boolean;
  connectedAt: string;
  /** Sliding heartbeat marker (ISO) — freshness input to derivePresenceState. */
  lastSeenAt: string;
  /** Last time the durable presence mirror was flushed (ISO) — lazy-write bookkeeping. */
  lastMirrorAt: string;
  /** How many times this member re-established the connection. */
  reconnectCount: number;
}

export interface RegisterSessionResult {
  session: VideoRoomSessionRecord;
  /**
   * A pre-existing socket id for the same (user, device), if this registration
   * is a duplicate connection the caller evicts. Null when this is the only
   * session for that device.
   */
  duplicateOf: string | null;
}

/** Per-heartbeat client signals (activity flag today; quality later). */
export interface HeartbeatInput {
  inBackground?: boolean;
}

/**
 * Per-connection session manager: registry, heartbeat, duplicate-connection
 * detection, and expiry of sessions whose client dropped without a clean leave.
 * The durable mirror (video_room_presence) is the queryable index the expiry
 * sweep scans; Redis holds the hot session records.
 */
export interface IRoomSessionManager {
  /** Register a socket's session (durable mirror + Redis registry + heartbeat TTL). */
  register(input: RegisterSessionInput): Promise<RegisterSessionResult>;

  /**
   * Refresh a session's heartbeat/TTL and recompute its presence state. Returns
   * false if the session is unknown/expired (evicted or already reclaimed).
   */
  heartbeat(socketId: string, input?: HeartbeatInput): Promise<boolean>;

  /** The session record for a socket, or null. */
  getSession(socketId: string): Promise<VideoRoomSessionRecord | null>;

  /** Live session socket ids in a room. */
  listRoomSessions(roomId: string): Promise<string[]>;

  /** A user's live session socket ids across rooms (reverse index). */
  listUserSessions(userId: string): Promise<string[]>;

  /** End a session (clean leave or eviction). Returns the ended record, or null if unknown. */
  end(socketId: string): Promise<VideoRoomSessionRecord | null>;

  /** End every live session a user holds in a given room. Returns the ended records. */
  endUserRoomSessions(roomId: string, userId: string): Promise<VideoRoomSessionRecord[]>;

  /** End every live session in a room (room-wide teardown). Returns the ended records. */
  endAllRoomSessions(roomId: string): Promise<VideoRoomSessionRecord[]>;

  /** Stamp a session's presence state (e.g. the disconnect fast-path → DISCONNECTED). */
  markPresence(
    socketId: string,
    state: VideoRoomPresenceState,
  ): Promise<VideoRoomSessionRecord | null>;

  /** Reclaim sessions last seen before `cutoff`. Returns the reclaimed presence rows. */
  expireStale(cutoff: Date): Promise<VideoRoomPresence[]>;
}
