import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import type { SocialUserCard } from '../interfaces/social.interface';

/**
 * Resolves user ids into lightweight social cards via PROFILE_SERVICE (the only
 * sanctioned cross-module read of user/profile data). Preserves input order and
 * silently drops ids that no longer resolve to a profile.
 */
@Injectable()
export class CardResolver {
  constructor(
    @Inject(PROFILE_SERVICE) private readonly profile: IProfileService,
    private readonly prisma: PrismaService,
  ) {}

  async resolve(ids: string[], viewerId?: string): Promise<SocialUserCard[]> {
    if (ids.length === 0) return [];
    const cards = await this.profile.getCards(ids);
    const byId = new Map(cards.map((c) => [c.id, c]));

    let followingSet = new Set<string>();
    let followersSet = new Set<string>();
    let friendsSet = new Set<string>();

    if (viewerId) {
      const [followingRows, followerRows, friendRows] = await Promise.all([
        this.prisma.follow.findMany({
          where: { followerId: viewerId, followingId: { in: ids } },
          select: { followingId: true },
        }),
        this.prisma.follow.findMany({
          where: { followerId: { in: ids }, followingId: viewerId },
          select: { followerId: true },
        }),
        this.prisma.friendship.findMany({
          where: {
            OR: [
              { userAId: viewerId, userBId: { in: ids } },
              { userBId: viewerId, userAId: { in: ids } },
            ],
          },
          select: { userAId: true, userBId: true },
        }),
      ]);

      followingSet = new Set(followingRows.map((r) => r.followingId));
      followersSet = new Set(followerRows.map((r) => r.followerId));
      friendsSet = new Set(
        friendRows.map((r) => (r.userAId === viewerId ? r.userBId : r.userAId)),
      );
    }

    const out: SocialUserCard[] = [];
    for (const id of ids) {
      const c = byId.get(id);
      if (c) {
        const isFollowing = viewerId ? followingSet.has(id) : undefined;
        const isFollower = viewerId ? followersSet.has(id) : undefined;
        const isFriend = viewerId
          ? friendsSet.has(id) || (Boolean(isFollowing) && Boolean(isFollower))
          : undefined;

        out.push({
          userId: c.id,
          username: c.username,
          fullName: c.fullName,
          avatarUrl: c.avatarUrl,
          equippedFrameUrl: c.equippedFrameUrl ?? null,
          verified: c.verified,
          level: c.level,
          vipLevel: c.vipLevel,
          ...(viewerId && { isFollowing, isFollower, isFriend }),
        });
      }
    }
    return out;
  }

  async resolveOne(id: string, viewerId?: string): Promise<SocialUserCard | null> {
    const [card] = await this.resolve([id], viewerId);
    return card ?? null;
  }
}
