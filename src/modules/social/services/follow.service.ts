import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import {
  PRIVACY_SERVICE,
  type IPrivacyService,
} from 'src/modules/privacy/interfaces/privacy.interface';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import { FollowedEvent, UnfollowedEvent } from '../events/social.events';
import type { SocialUserCard } from '../interfaces/social.interface';
import { FollowRepository } from '../repositories/follow.repository';
import { CardResolver } from './card.resolver';

/**
 * Follow system. Enforces no-self-follow + block gating, keeps the follow edge
 * unique, and adjusts the denormalised follower/following counters ONLY when a
 * row actually changed. Counter writes happen after the edge write (separate
 * PROFILE_SERVICE call — eventual consistency, matching the denormalised-counter
 * design). Publishes follow/unfollow events for realtime + notifications.
 */
@Injectable()
export class FollowService {
  constructor(
    private readonly repo: FollowRepository,
    private readonly cards: CardResolver,
    @Inject(PRIVACY_SERVICE) private readonly privacy: IPrivacyService,
    @Inject(PROFILE_SERVICE) private readonly profile: IProfileService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async follow(followerId: string, targetId: string): Promise<{ following: boolean }> {
    if (followerId === targetId) {
      throw new BusinessException(
        ERROR_CODES.CANNOT_FOLLOW_SELF,
        'You cannot follow yourself',
        HttpStatus.BAD_REQUEST,
      );
    }
    const targetProfile = await this.profile.getProfileView(targetId);
    if (!targetProfile || targetProfile.isHiddenAccount) {
      throw new BusinessException(ERROR_CODES.NOT_FOUND, 'User not found', HttpStatus.NOT_FOUND);
    }
    if (await this.privacy.isBlockedEitherWay(followerId, targetId)) {
      throw new BusinessException(
        ERROR_CODES.USER_BLOCKED,
        'You cannot follow this user',
        HttpStatus.FORBIDDEN,
      );
    }
    const created = await this.repo.create(followerId, targetId);
    if (!created) {
      throw new BusinessException(
        ERROR_CODES.ALREADY_FOLLOWING,
        'You already follow this user',
        HttpStatus.CONFLICT,
      );
    }
    await this.profile.incrementStatistic(targetId, 'followersCount', 1);
    await this.profile.incrementStatistic(followerId, 'followingCount', 1);
    const followersCount = await this.repo.countFollowers(targetId);
    await this.bus.publish(
      new FollowedEvent({ followerId, followingId: targetId, followersCount }),
    );
    return { following: true };
  }

  async unfollow(followerId: string, targetId: string): Promise<{ following: boolean }> {
    const removed = await this.repo.delete(followerId, targetId);
    if (removed) {
      await this.profile.incrementStatistic(targetId, 'followersCount', -1);
      await this.profile.incrementStatistic(followerId, 'followingCount', -1);
      const followersCount = await this.repo.countFollowers(targetId);
      await this.bus.publish(
        new UnfollowedEvent({ followerId, followingId: targetId, followersCount }),
      );
    }
    return { following: false };
  }

  async followers(userId: string, page: number, limit: number): Promise<Paginated<SocialUserCard>> {
    const { ids, total } = await this.repo.pageFollowerIds(userId, (page - 1) * limit, limit);
    return buildPaginated(await this.cards.resolve(ids), total, page, limit);
  }

  async following(userId: string, page: number, limit: number): Promise<Paginated<SocialUserCard>> {
    const { ids, total } = await this.repo.pageFollowingIds(userId, (page - 1) * limit, limit);
    return buildPaginated(await this.cards.resolve(ids), total, page, limit);
  }

  /**
   * "Mutual connections": accounts that BOTH `viewerId` and `targetId` follow.
   * Computed in-memory from the two following-sets (indexed lookups), then
   * paginated over the ordered intersection.
   */
  async mutual(
    viewerId: string,
    targetId: string,
    page: number,
    limit: number,
  ): Promise<Paginated<SocialUserCard>> {
    const [mine, theirs] = await Promise.all([
      this.repo.followingIds(viewerId),
      this.repo.followingIds(targetId),
    ]);
    const theirSet = new Set(theirs);
    const common = mine.filter((id) => theirSet.has(id));
    const total = common.length;
    const slice = common.slice((page - 1) * limit, (page - 1) * limit + limit);
    return buildPaginated(await this.cards.resolve(slice), total, page, limit);
  }
}
