import { Injectable } from '@nestjs/common';
import type { IRelationshipProvider } from 'src/modules/privacy/interfaces/relationship-provider.interface';
import { FollowRepository } from '../repositories/follow.repository';
import { FriendshipRepository } from '../repositories/friendship.repository';

/**
 * Real implementation of the privacy module's RELATIONSHIP_SERVICE seam, backed
 * by the social graph tables. Rebinding this (in SocialModule) lights up the
 * FRIENDS_ONLY / FOLLOWERS_ONLY privacy levels with no change to privacy logic.
 * Depends only on social repositories → the DI graph stays acyclic.
 */
@Injectable()
export class SocialRelationshipProvider implements IRelationshipProvider {
  constructor(
    private readonly friendships: FriendshipRepository,
    private readonly follows: FollowRepository,
  ) {}

  isFriend(a: string, b: string): Promise<boolean> {
    return this.friendships.exists(a, b);
  }

  /** Does `viewer` follow `target`? */
  isFollower(viewer: string, target: string): Promise<boolean> {
    return this.follows.exists(viewer, target);
  }
}
