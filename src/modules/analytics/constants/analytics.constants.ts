import type { RoomMemberRole } from '@prisma/client';

/** Room roles allowed to view a room's analytics (owner + admins). */
export const ANALYTICS_ROOM_MANAGER_ROLES: ReadonlyArray<RoomMemberRole> = [
  'OWNER',
  'ADMIN',
  'PREMIUM_ADMIN',
];

/** Platform roles allowed to view any analytics surface. */
export const ANALYTICS_ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN'] as const;

/** BullMQ job name + daily cron for the rollup (00:15, mirrors rankings). */
export const ANALYTICS_ROLLUP_JOB = 'analytics.rollup';
export const ANALYTICS_ROLLUP_CRON = '15 0 * * *';
export const ANALYTICS_ROLLUP_JOB_ID = 'analytics-rollup-job';

/** How long live counter keys live before self-expiring (well past rollup). */
export const ANALYTICS_COUNTER_TTL_SECONDS = 3 * 24 * 60 * 60;

/** Default number of days returned in daily-series reads. */
export const ANALYTICS_DEFAULT_SERIES_DAYS = 30;

/**
 * Engagement score weights (documented composite). Applied to a period's
 * counters: joins + messages + gifts + speaking-minutes. Higher = more engaged.
 */
export const ENGAGEMENT_WEIGHTS = {
  join: 1,
  message: 1,
  gift: 5,
  speakingMinute: 2,
} as const;

/** YYYYMMDD key for a date (defaults to now). */
export function dateKeyOf(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/** dateKey for N days before `date`. */
export function dateKeyDaysAgo(days: number, date: Date = new Date()): string {
  const d = new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
  return dateKeyOf(d);
}

// ---- Redis live-counter keys (all dateKey-scoped, single-key/cluster-safe) ----

export const roomCounterKey = (roomId: string, dateKey: string): string =>
  `analytics:rt:room:{${roomId}}:${dateKey}`;
export const roomVisitorsKey = (roomId: string, dateKey: string): string =>
  `analytics:rt:room:visitors:{${roomId}}:${dateKey}`;
export const roomPeakKey = (roomId: string, dateKey: string): string =>
  `analytics:rt:room:peak:{${roomId}}:${dateKey}`;
export const creatorCounterKey = (userId: string, dateKey: string): string =>
  `analytics:rt:creator:{${userId}}:${dateKey}`;
export const roomsActiveKey = (dateKey: string): string => `analytics:rt:rooms:${dateKey}`;
export const creatorsActiveKey = (dateKey: string): string => `analytics:rt:creators:${dateKey}`;

/** Hash fields tracked per room / per creator for a day. */
export type RoomCounterField = 'joins' | 'messages' | 'giftCount' | 'giftCoins' | 'speakingSeconds';
export type CreatorCounterField =
  | 'giftsReceivedCount'
  | 'giftCoinsReceived'
  | 'creatorEarnings'
  | 'roomsHosted'
  | 'speakingSeconds';
