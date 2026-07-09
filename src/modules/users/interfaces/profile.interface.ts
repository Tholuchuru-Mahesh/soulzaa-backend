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

export interface IProfileService {
  getProfileView(userId: string): Promise<ProfileView | null>;
  /** View a profile by username as `viewerId` (undefined = anonymous). Privacy-gated. */
  getProfileByUsername(username: string, viewerId?: string): Promise<ProfileView | null>;
  getStatistics(userId: string): Promise<StatisticsView | null>;
  /** Atomically adjust a counter (delta may be negative). Returns nothing. */
  incrementStatistic(userId: string, field: StatisticField, delta: number): Promise<void>;
  /** Search users; results exclude anyone in a block relationship with `viewerId`. */
  search(
    query: string,
    opts: { page?: number; limit?: number; country?: string },
    viewerId?: string,
  ): Promise<Paginated<UserCard>>;
}
