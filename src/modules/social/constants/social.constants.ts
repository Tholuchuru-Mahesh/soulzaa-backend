/**
 * Social module constants: the realtime namespace + event names it fans out on,
 * expiry TTLs, and scoring weights for best-friends / recommendations. Event
 * names are colon-namespaced (matching the platform's `presence:*` convention)
 * and are emitted to a recipient's per-user room on the `/notifications`
 * namespace.
 */
import { SOCKET_NAMESPACES } from 'src/common/constants/socket.constants';

/** Social realtime rides the existing notifications namespace (per-user rooms). */
export const SOCIAL_NAMESPACE = SOCKET_NAMESPACES.NOTIFICATIONS;

/** Server -> client social events (delivered to the recipient's `user:<id>` room). */
export const SOCIAL_SOCKET_EVENTS = {
  FRIEND_REQUEST: 'friend:request',
  FRIEND_ACCEPTED: 'friend:accepted',
  FRIEND_DECLINED: 'friend:declined',
  FRIEND_REMOVED: 'friend:removed',
  FOLLOW: 'follow',
  UNFOLLOW: 'unfollow',
  PRESENCE_UPDATED: 'presence:updated',
  INVITATION_SENT: 'invitation:sent',
  INVITATION_ACCEPTED: 'invitation:accepted',
  INVITATION_DECLINED: 'invitation:declined',
  SHARE_LINK_UPDATED: 'share:link_updated',
} as const;

/** How long a pending friend request / invitation stays actionable. */
export const FRIEND_REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const INVITATION_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Max user ids accepted by the batch presence query. */
export const PRESENCE_QUERY_MAX = 100;

/** Number of derived best-friends flagged per user. */
export const BEST_FRIENDS_TOP_N = 6;

/** Interaction scoring weights (accrued into UserInteraction / Friendship). */
export const INTERACTION_WEIGHTS = {
  GIFT: 5,
  CHAT: 1,
  CO_PRESENCE: 2,
} as const;

/** Redis key for the rolling trending-hosts sorted set. */
export const TRENDING_HOSTS_KEY = 'social:trending:hosts';
