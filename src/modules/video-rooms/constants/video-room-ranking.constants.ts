import type { RankingPeriodName } from 'src/modules/rankings/interfaces';

/**
 * VR-13 ranking constants: the Redis namespace, the scope/dimension vocabulary,
 * key builders, job names and client-facing socket events.
 *
 * The `vrank` namespace is load-bearing, not cosmetic. The platform rankings
 * module owns `rankings:*` and already counts video-room gifts via its own
 * `gift.sent` listener; writing into that namespace from here would double-count
 * real coins. Every key this module produces starts with `vrank`.
 */
export const VIDEO_ROOM_RANKING_NAMESPACE = 'vrank';

/** What is being ranked. Members are user ids except ROOMS, which is room ids. */
export enum VideoRoomRankingDimension {
  HOSTS = 'hosts',
  GIFTERS = 'gifters',
  RECEIVERS = 'receivers',
  ROOMS = 'rooms',
  PK = 'pk',
  TREASURE = 'treasure',
  VIP = 'vip',
}

const DIMENSIONS = new Set<string>(Object.values(VideoRoomRankingDimension));

export function isRankingDimension(value: string): value is VideoRoomRankingDimension {
  return DIMENSIONS.has(value);
}

/**
 * Safe coercion for use inside catch blocks whose whole purpose is to not
 * throw. `(err as Error).message` blows up when `err` is `undefined`/`null`
 * (e.g. a subscriber doing `throw undefined` or an empty `Promise.reject()`),
 * which turns a swallow-and-log catch into a throw — exactly what it exists
 * to prevent. Shared by every VR-13 write-path file whose catch blocks must
 * never themselves throw.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The ranking universe a ladder covers. */
export type RankingScopeKind = 'global' | 'room' | 'country' | 'city';

export interface ParsedRankingScope {
  kind: RankingScopeKind;
  /** Absent for the global scope, which has no id. */
  id?: string;
}

export const scopeGlobal = (): string => 'g';
export const scopeRoom = (roomId: string): string => `r:${roomId}`;
/** Country codes are normalised so `c:in` and `c:IN` cannot become two ladders. */
export const scopeCountry = (code: string): string => `c:${code.toUpperCase()}`;
export const scopeCity = (cityId: string): string => `y:${cityId}`;

export function parseScope(scope: string): ParsedRankingScope | null {
  if (scope === 'g') return { kind: 'global' };
  const [prefix, ...rest] = scope.split(':');
  const id = rest.join(':');
  if (!id) return null;
  if (prefix === 'r') return { kind: 'room', id };
  if (prefix === 'c') return { kind: 'country', id };
  if (prefix === 'y') return { kind: 'city', id };
  return null;
}

/** Periods incremented inline on the write path. */
export const VIDEO_ROOM_RANKING_HOT_PERIODS: readonly RankingPeriodName[] = [
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'alltime',
];

/** Periods produced by ZUNIONSTORE in an aggregation job. */
export const VIDEO_ROOM_RANKING_DERIVED_PERIODS: readonly RankingPeriodName[] = [
  'quarterly',
  'yearly',
];

/** BullMQ job names on the shared RANKING_PROCESSING queue. */
export const VIDEO_ROOM_RANKING_JOBS = {
  AGGREGATE_HOURLY: 'video-room.ranking.aggregate.hourly',
  AGGREGATE_DAILY: 'video-room.ranking.aggregate.daily',
  AGGREGATE_WEEKLY: 'video-room.ranking.aggregate.weekly',
  AGGREGATE_MONTHLY: 'video-room.ranking.aggregate.monthly',
  AGGREGATE_YEARLY: 'video-room.ranking.aggregate.yearly',
  CACHE_REFRESH: 'video-room.ranking.cache-refresh',
  CLEANUP: 'video-room.ranking.cleanup',
} as const;

/**
 * Client-facing realtime events, emitted into the existing `/video-room`
 * namespace. Dotted `video_room.*` names, matching every shipped VR phase —
 * the phase brief writes these camelCase (`rankingUpdated`), but the wire
 * convention on this namespace is the dotted form and consistency wins.
 */
export const VIDEO_ROOM_RANKING_SOCKET_EVENTS = {
  RANKING_UPDATED: 'video_room.ranking.updated',
  LEADERBOARD_UPDATED: 'video_room.leaderboard.updated',
  HOST_RANK_UPDATED: 'video_room.ranking.host_updated',
  GIFTER_RANK_UPDATED: 'video_room.ranking.gifter_updated',
  ROOM_RANK_UPDATED: 'video_room.ranking.room_updated',
  PK_RANK_UPDATED: 'video_room.ranking.pk_updated',
  TREASURE_RANK_UPDATED: 'video_room.ranking.treasure_updated',
} as const;

/** Dimension → the socket event announcing its movement. */
export const DIMENSION_SOCKET_EVENT: Record<VideoRoomRankingDimension, string> = {
  [VideoRoomRankingDimension.HOSTS]: VIDEO_ROOM_RANKING_SOCKET_EVENTS.HOST_RANK_UPDATED,
  [VideoRoomRankingDimension.GIFTERS]: VIDEO_ROOM_RANKING_SOCKET_EVENTS.GIFTER_RANK_UPDATED,
  [VideoRoomRankingDimension.RECEIVERS]: VIDEO_ROOM_RANKING_SOCKET_EVENTS.RANKING_UPDATED,
  [VideoRoomRankingDimension.ROOMS]: VIDEO_ROOM_RANKING_SOCKET_EVENTS.ROOM_RANK_UPDATED,
  [VideoRoomRankingDimension.PK]: VIDEO_ROOM_RANKING_SOCKET_EVENTS.PK_RANK_UPDATED,
  [VideoRoomRankingDimension.TREASURE]: VIDEO_ROOM_RANKING_SOCKET_EVENTS.TREASURE_RANK_UPDATED,
  [VideoRoomRankingDimension.VIP]: VIDEO_ROOM_RANKING_SOCKET_EVENTS.RANKING_UPDATED,
};

/** Ranks a guest may read. No pagination past this, no self-rank, no history. */
export const VIDEO_ROOM_RANKING_GUEST_LIMIT = 10;

/** Entries persisted per ladder at period close. */
export const VIDEO_ROOM_RANKING_SNAPSHOT_SIZE = 100;

/** Default and maximum page size for ranking reads. */
export const VIDEO_ROOM_RANKING_DEFAULT_PAGE_SIZE = 20;
export const VIDEO_ROOM_RANKING_MAX_PAGE_SIZE = 100;

/** Fleet-wide lock so exactly one instance runs a given aggregation. */
export function videoRoomRankingAggregationLockKey(jobKey: string): string {
  return `vrank:agg:lock:${jobKey}`;
}

/** Per-room socket coalescing marker — one broadcast per window per room. */
export function videoRoomRankingCoalesceKey(roomId: string): string {
  return `vrank:coalesce:{r:${roomId}}`;
}
