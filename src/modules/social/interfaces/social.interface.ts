import type { FriendRequestStatus, InvitationType, PresenceStatus } from '@prisma/client';

/**
 * Public contract for the social module. Other modules resolve SOCIAL_SERVICE
 * for graph reads (e.g. presence audience = friends ∪ followers). The privacy
 * module additionally consumes RELATIONSHIP_SERVICE, bound to this module's
 * SocialRelationshipProvider. Internals (repositories, listeners) stay private.
 */
export const SOCIAL_SERVICE = Symbol('SOCIAL_SERVICE');

/** A lightweight social user card returned by every list/edge endpoint. */
export interface SocialUserCard {
  userId: string;
  username: string;
  fullName: string | null;
  avatarUrl: string | null;
  equippedFrameUrl?: string | null;
  verified: boolean;
  level: number;
  vipLevel: number;
}

/** Rich presence snapshot for a user (privacy-gated fields may be null). */
export interface PresenceView {
  userId: string;
  status: PresenceStatus;
  currentRoomId: string | null;
  lastSeenAt: Date | null;
  online: boolean;
}

/** A friend, with best-friend flag + derived priority + live presence. */
export interface FriendView extends SocialUserCard {
  isBestFriend: boolean;
  priority: number | null;
  presence: PresenceView | null;
  friendsSince: Date;
}

export interface FriendRequestView {
  requestId: string;
  status: FriendRequestStatus;
  message: string | null;
  createdAt: Date;
  expiresAt: Date;
  user: SocialUserCard;
}

export interface InvitationView {
  invitationId: string;
  type: InvitationType;
  targetId: string | null;
  payload: unknown;
  createdAt: Date;
  expiresAt: Date;
  user: SocialUserCard;
}

export interface SuggestionView extends SocialUserCard {
  reason: string;
  score: number;
  mutualCount: number | null;
}

/** The narrow surface other modules may depend on. */
export interface ISocialService {
  /** All user ids the given user is friends with (both directions of the pair). */
  friendIds(userId: string): Promise<string[]>;
  /** All user ids that follow the given user. */
  followerIds(userId: string): Promise<string[]>;
  /** Union of friends ∪ followers — the audience for a presence broadcast. */
  presenceAudienceIds(userId: string): Promise<string[]>;
  /** One page of follower ids (most recent first) + total, for chunked fan-out. */
  pageFollowerIds(
    userId: string,
    skip: number,
    take: number,
  ): Promise<{ ids: string[]; total: number }>;
  /** New followers gained by `userId` within a time window. */
  countNewFollowers(userId: string, start: Date, end: Date): Promise<number>;
}
