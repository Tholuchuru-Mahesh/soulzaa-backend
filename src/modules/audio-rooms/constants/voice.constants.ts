/**
 * AR-2 voice constants: Redis key builders (all `{roomId}` hash-tagged for
 * Cluster-safety) and the tuning knobs for heartbeat/quality/active-speaker. The
 * DB (`voice_sessions`) is authoritative; Redis holds the hot voice presence,
 * speaking set, heartbeat TTLs, and the read-through voice-state snapshot.
 */

/** Set of user ids currently in the voice channel. */
export function voicePresenceKey(roomId: string): string {
  return `audio-room:{${roomId}}:voice`;
}

/** Set of user ids currently speaking (active-speaker indicators). */
export function voiceSpeakingKey(roomId: string): string {
  return `audio-room:{${roomId}}:voice:speaking`;
}

/** Per-user heartbeat marker with a TTL — absence ⇒ the client went silent. */
export function voiceHeartbeatKey(roomId: string, userId: string): string {
  return `audio-room:{${roomId}}:voice:hb:${userId}`;
}

/** Cached voice-state snapshot (participants + mute/speaking/quality). */
export function voiceStateCacheKey(roomId: string): string {
  return `audio-room:{${roomId}}:voice-state`;
}

/** Per-room lock serialising voice-session state transitions. */
export function voiceLockKey(roomId: string): string {
  return `audio-room:voice:{${roomId}}`;
}

/** Lock guarding the fleet-wide heartbeat-timeout sweep. */
export const VOICE_MONITOR_LOCK_KEY = 'audio-room:voice:monitor';

/** How long a heartbeat marker lives before the session is considered stale. */
export const VOICE_HEARTBEAT_TTL_SECONDS = 30;

/** How often the heartbeat-timeout monitor sweeps for stale sessions. */
export const VOICE_MONITOR_INTERVAL_MS = 10_000;

/** Persist a QUALITY_SAMPLED log row every Nth heartbeat/quality report. */
export const VOICE_QUALITY_SAMPLE_EVERY = 6;

/** Voice-state snapshot cache TTL (seconds). */
export const VOICE_STATE_TTL_SECONDS = 30;

/** Allowed client-reported audio output routes. */
export const AUDIO_ROUTES = ['SPEAKER', 'EARPIECE', 'BLUETOOTH', 'WIRED'] as const;
export type AudioRoute = (typeof AUDIO_ROUTES)[number];
