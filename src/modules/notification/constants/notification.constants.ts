import { SOCKET_NAMESPACES } from 'src/common/constants/socket.constants';

/**
 * Notification module constants: the socket namespace it fans out on and the
 * `notification.*` client event names.
 */

/**
 * The notification centre shares the `/notifications` namespace with the social
 * module (friend/follow/presence). One namespace, one socket, two producers —
 * a client that wants its badge does not open a second connection to get it.
 */
export const NOTIFICATION_NAMESPACE = SOCKET_NAMESPACES.NOTIFICATIONS;

/**
 * Client-facing realtime events, all delivered to the owner's per-user room
 * (`user:<id>`) — which is what makes them multi-device by construction: reading a
 * notification on a phone clears the badge on the tablet, because both sockets sit
 * in that room.
 *
 * Every payload carries `unreadCount`. The badge is the whole reason these events
 * exist, and making the client re-derive it (or re-poll for it) after each event is
 * how badges drift out of sync with their list.
 */
export const NOTIFICATION_SOCKET_EVENTS = {
  /** A notification row was created. Payload: `{ notification, unreadCount }`. */
  NEW: 'notification.new',
  /** One notification was read, on some device. Payload: `{ id, unreadCount }`. */
  READ: 'notification.read',
  /** Everything was marked read. Payload: `{ unreadCount: 0 }`. */
  READ_ALL: 'notification.read_all',
  /** Preferences changed — syncs the Settings screen across the owner's devices. */
  PREFERENCES: 'notification.preferences',
} as const;
