/** Realtime namespaces (mirror the Step-4 gateways). */
export const SOCKET_NAMESPACES = {
  NOTIFICATIONS: '/notifications',
  CHAT: '/chat',
  AUDIO_ROOM: '/audio-room',
  VIDEO_ROOM: '/video-room',
  LIVE: '/live',
  GIFTS: '/gifts',
} as const;

/** Standard cross-cutting socket events (domain events are namespaced per module). */
export const SOCKET_EVENTS = {
  PRESENCE_ONLINE: 'presence:online',
  PRESENCE_OFFLINE: 'presence:offline',
  ROOM_JOIN: 'room:join',
  ROOM_LEAVE: 'room:leave',
  PING: 'ping',
  ERROR: 'error',
} as const;

/** Per-user room every socket joins, so a user can be targeted cross-instance. */
export const USER_ROOM_PREFIX = 'user:';
