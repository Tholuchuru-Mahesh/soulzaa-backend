import { SOCKET_NAMESPACES } from 'src/common/constants/socket.constants';

/**
 * Live-stream moderation Redis keys + the `/live` namespace constant.
 * Mirrors video-room-moderation.constants.ts's mute/block mirror key
 * builders (SET membership for O(1) enforcement + a per-user PX-ttl key so
 * TEMPORARY mutes/bans self-expire).
 */
export const LIVE_STREAM_NAMESPACE: string = SOCKET_NAMESPACES.LIVE;

/** Sentinel actor id for anonymized moderator actions in socket broadcasts — matches audio-rooms'/video-rooms' value. */
export const SYSTEM_MODERATOR_ID = '00000000-0000-0000-0000-000000000000';

/** Socket events broadcast to the stream's viewer room. */
export const LIVE_STREAM_SOCKET_EVENTS = {
  USER_MUTED: 'live_stream.user_muted',
  USER_KICKED: 'live_stream.user_kicked',
  USER_BANNED: 'live_stream.user_banned',
} as const;

export function liveStreamMuteSetKey(streamId: string): string {
  return `live-stream:{${streamId}}:mutes`;
}

export function liveStreamMuteKey(streamId: string, userId: string): string {
  return `live-stream:{${streamId}}:mute:${userId}`;
}

export function liveStreamBanSetKey(streamId: string): string {
  return `live-stream:{${streamId}}:bans`;
}

export function liveStreamBanKey(streamId: string, userId: string): string {
  return `live-stream:{${streamId}}:ban:${userId}`;
}
