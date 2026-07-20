import { VideoRoomPresenceState } from '../enums';
import type { VideoRoomSessionRecord } from '../interfaces/room-session-manager.interface';

/**
 * Tunable knobs for the presence state machine, isolated here so the thresholds
 * are one edit away. `MISS_FACTOR` = how many heartbeat intervals may be missed
 * before a session is treated as RECONNECTING; `FIRST_BEAT_FACTOR` = how many
 * intervals a brand-new session may stay CONNECTING before its first heartbeat.
 */
export const PRESENCE_MISS_FACTOR = 2;
export const PRESENCE_FIRST_BEAT_FACTOR = 1;

/** The freshness thresholds derivePresenceState reads (seconds). */
export interface PresenceStateThresholds {
  heartbeatIntervalSeconds: number;
  reconnectTimeoutSeconds: number;
  idleTimeoutSeconds: number;
}

type PresenceInput = Pick<
  VideoRoomSessionRecord,
  'presenceState' | 'inBackground' | 'lastSeenAt' | 'reconnectCount'
>;

/**
 * Pure, side-effect-free single source of truth for a member's presence. Given a
 * session record (or null), the current time, and the config thresholds, it
 * returns exactly one {@link VideoRoomPresenceState}. Ordering matters: the
 * sticky terminals (LEFT, observed DISCONNECTED) and the grace cutoff are
 * checked before the ONLINE/IDLE bands so a reclaimed or dropped session can
 * never read as live.
 *
 * Note: with the platform defaults `idleTimeoutSeconds` (300) exceeds
 * `reconnectTimeoutSeconds` (120), so time-based IDLE is unreachable — IDLE is
 * entered via the client `inBackground` flag (a backgrounded app that keeps
 * heartbeating). The time-based branch is retained as a defensive fallback for
 * configs where idle < reconnect.
 */
export function derivePresenceState(
  session: PresenceInput | null,
  nowMs: number,
  cfg: PresenceStateThresholds,
): VideoRoomPresenceState {
  if (!session) return VideoRoomPresenceState.OFFLINE;

  const ageSeconds = (nowMs - Date.parse(session.lastSeenAt)) / 1000;
  const graceElapsed = ageSeconds > cfg.reconnectTimeoutSeconds;

  // Sticky terminal — an explicit leave / reclaim never re-animates.
  if (session.presenceState === VideoRoomPresenceState.LEFT) {
    return VideoRoomPresenceState.LEFT;
  }

  // Socket confirmed dead by the infra presence event: hold DISCONNECTED until
  // the grace window elapses, then reclaim to LEFT.
  if (session.presenceState === VideoRoomPresenceState.DISCONNECTED) {
    return graceElapsed ? VideoRoomPresenceState.LEFT : VideoRoomPresenceState.DISCONNECTED;
  }

  // Grace elapsed with no heartbeat — reclaim.
  if (graceElapsed) return VideoRoomPresenceState.LEFT;

  // Brand-new session still inside its first-beat window.
  if (
    session.reconnectCount === 0 &&
    session.presenceState === VideoRoomPresenceState.CONNECTING &&
    ageSeconds <= cfg.heartbeatIntervalSeconds * PRESENCE_FIRST_BEAT_FACTOR
  ) {
    return VideoRoomPresenceState.CONNECTING;
  }

  // Heartbeats late (but within grace) — trying to reconnect. Dominates IDLE.
  if (ageSeconds > cfg.heartbeatIntervalSeconds * PRESENCE_MISS_FACTOR) {
    return VideoRoomPresenceState.RECONNECTING;
  }

  // Heartbeating but the client says it is backgrounded (or, defensively, has
  // been quiet past the idle timeout).
  if (session.inBackground || ageSeconds > cfg.idleTimeoutSeconds) {
    return VideoRoomPresenceState.IDLE;
  }

  return VideoRoomPresenceState.ONLINE;
}
