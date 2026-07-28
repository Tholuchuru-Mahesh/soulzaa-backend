import type { Gender, VerificationStatus, VerificationType } from '@prisma/client';
import type { Paginated } from 'src/common/interfaces/api-response.interface';

/**
 * Public contract for the user PROFILE surface — separate from the identity
 * contract (IUsersService). Other modules drive statistics through
 * `incrementStatistic` (gifts → giftsReceived, follows → followersCount) and
 * read the composed profile/stats. Internals (repository, search provider,
 * caching) stay private.
 */
export const PROFILE_SERVICE = Symbol('PROFILE_SERVICE');

/** Statistics a caller may atomically increment (maps to user_statistics columns). */
export type StatisticField =
  | 'followersCount'
  | 'followingCount'
  | 'friendsCount'
  | 'giftsSent'
  | 'giftsReceived'
  | 'coinsReceived'
  | 'audioMinutes'
  | 'videoMinutes'
  | 'liveMinutes'
  | 'exp';

export interface StatisticsView {
  followersCount: number;
  followingCount: number;
  friendsCount: number;
  giftsSent: number;
  giftsReceived: number;
  coinsReceived: number;
  audioHours: number;
  videoHours: number;
  liveHours: number;
  exp: number;
  level: number;
  vipLevel: number;
}

export interface VerificationView {
  verified: boolean;
  status: VerificationStatus;
  type: VerificationType | null;
}

/** Composed profile read model (identity + profile + statistics + verification). */
export interface ProfileView {
  id: string;
  username: string;
  fullName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  gender: Gender | null;
  birthday: Date | null;
  country: string | null;
  state: string | null;
  city: string | null;
  preferredLanguage: string | null;
  statistics: StatisticsView;
  verification: VerificationView;
  createdAt: Date;
}

/** Lightweight card returned by search / listings. */
export interface UserCard {
  id: string;
  username: string;
  fullName: string | null;
  avatarUrl: string | null;
  verified: boolean;
  level: number;
  vipLevel: number;
  country: string | null;
}

/**
 * Minimal public identity for cross-module display needs (e.g. games player
 * panels, video-room seat/request panels).
 *
 * The badge fields are optional so the original two-field consumers keep
 * compiling unchanged; `resolvePublicIdentities` always populates all six.
 */
export interface PublicIdentity {
  /** `fullName ?? username` — null only if neither exists. */
  displayName: string | null;
  avatarUrl: string | null;
  /** Raw handle, for surfaces that show @handle alongside the display name. */
  username?: string;
  /** `UserStatistics.level`; 1 when the row is absent. */
  level?: number;
  /** `UserStatistics.vipLevel`; 0 (not VIP) when the row is absent. */
  vipLevel?: number;
  /** `UserVerification.verified`; false when the row is absent. */
  verified?: boolean;
}

export interface IProfileService {
  getProfileView(userId: string): Promise<ProfileView | null>;
  /** View a profile by username as `viewerId` (undefined = anonymous). Privacy-gated. */
  getProfileByUsername(username: string, viewerId?: string): Promise<ProfileView | null>;
  /**
   * View a profile by a username *or* a user id (UUID) as `viewerId`. Privacy-gated.
   * Lets the opaque `/users/:x` route serve a tapped handle and a deep-linked id alike.
   */
  getPublicProfile(identifier: string, viewerId?: string): Promise<ProfileView | null>;
  getStatistics(userId: string): Promise<StatisticsView | null>;
  /** Resolve lightweight cards for a set of user ids (missing ids are dropped). */
  getCards(ids: string[]): Promise<UserCard[]>;
  /**
   * Batch-resolve display name + avatar URL plus badge fields (username,
   * level, vipLevel, verified) for a set of (human) user ids — for other
   * modules that just need identity, not the full profile/stats/verification
   * aggregate (e.g. games player panels, video-room seat/request panels).
   * Missing ids are absent from the map.
   */
  resolvePublicIdentities(ids: string[]): Promise<Map<string, PublicIdentity>>;
  /** Atomically adjust a counter (delta may be negative). Returns nothing. */
  incrementStatistic(userId: string, field: StatisticField, delta: number): Promise<void>;
  /** Search users; results exclude anyone in a block relationship with `viewerId`. */
  search(
    query: string,
    opts: { page?: number; limit?: number; country?: string },
    viewerId?: string,
  ): Promise<Paginated<UserCard>>;
}
