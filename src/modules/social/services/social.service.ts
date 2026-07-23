import { Injectable } from '@nestjs/common';
import type { ISocialService } from '../interfaces/social.interface';
import { FollowRepository } from '../repositories/follow.repository';
import { FriendshipRepository } from '../repositories/friendship.repository';

/**
 * The public SOCIAL_SERVICE surface other modules depend on. Today it answers
 * graph-membership queries — notably the presence audience (friends ∪ followers)
 * used to scope realtime `presence:updated` fan-out.
 */
@Injectable()
export class SocialService implements ISocialService {
  constructor(
    private readonly friendships: FriendshipRepository,
    private readonly follows: FollowRepository,
  ) {}

  friendIds(userId: string): Promise<string[]> {
    return this.friendships.friendIds(userId);
  }

  followerIds(userId: string): Promise<string[]> {
    return this.follows.followerIds(userId);
  }

  pageFollowerIds(
    userId: string,
    skip: number,
    take: number,
  ): Promise<{ ids: string[]; total: number }> {
    return this.follows.pageFollowerIds(userId, skip, take);
  }

  async presenceAudienceIds(userId: string): Promise<string[]> {
    const [friends, followers] = await Promise.all([
      this.friendIds(userId),
      this.followerIds(userId),
    ]);
    return [...new Set([...friends, ...followers])];
  }
}
