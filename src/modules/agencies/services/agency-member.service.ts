import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import type {
  MemberCoinMetricDelta,
  MemberMetricDelta,
} from '../interfaces/agency-member.interface';
import { AgencyCommunityService } from './agency-community.service';
import { AgencyMemberScoreService } from './agency-member-score.service';

/** A member counts as active if they have used the app inside this window. */
const ACTIVE_WINDOW_DAYS = 30;
/** The window every "vs last month" figure is measured over, and against. */
const TREND_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE_SIZE = 100;

/**
 * The agency's own community — the member list and one member's detail.
 *
 * Every read is scoped to the caller's agency through `AgencyRelationship`.
 * An agency may only ever see users linked to it, which is why nothing here
 * takes a user id without first proving that user is one of its members.
 */
@Injectable()
export class AgencyMemberService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly community: AgencyCommunityService,
    // Display name and avatar come from the profile seam rather than straight
    // off `users`: they are not columns there, and this path also honours the
    // hidden-account rules.
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
    private readonly scores: AgencyMemberScoreService,
  ) {}

  /**
   * Proves [userId] is an active member of [agencyId], or throws.
   *
   * Public and shared by every member sub-resource. One implementation means a
   * new endpoint cannot forget the check — and the check is the only thing
   * standing between a guessed uuid and another agency's user.
   */
  async assertMember(agencyId: string, userId: string): Promise<{ effectiveFrom: Date }> {
    const relationship = await this.prisma.agencyRelationship.findUnique({
      where: { agencyId_hostId: { agencyId, hostId: userId } },
      select: { effectiveFrom: true, status: true },
    });
    if (!relationship || relationship.status !== 'ACTIVE') {
      throw new NotFoundException('This user is not a member of your agency');
    }
    return { effectiveFrom: relationship.effectiveFrom };
  }

  /**
   * The member list, newest joiner first.
   *
   * [search] matches the username or the user id, which is what the screen's
   * "name, ID or country" box offers.
   */
  async listMembers(
    agencyId: string,
    options: { search?: string; page?: number; limit?: number } = {},
  ) {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), MAX_PAGE_SIZE);
    const page = Math.max(options.page ?? 1, 1);

    const relationships = await this.prisma.agencyRelationship.findMany({
      where: { agencyId, status: 'ACTIVE' },
      orderBy: { effectiveFrom: 'desc' },
      select: { hostId: true, effectiveFrom: true },
    });

    if (relationships.length === 0) {
      return { items: [], page, limit, total: 0, totalPages: 0 };
    }

    const joinedAtById = new Map(relationships.map((r) => [r.hostId, r.effectiveFrom]));
    const memberIds = relationships.map((r) => r.hostId);

    // The search runs over the member set rather than over all users, so it can
    // never surface somebody who is not in this agency.
    const search = options.search?.trim();
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: memberIds },
        ...(search
          ? {
              OR: [
                { username: { contains: search, mode: 'insensitive' as const } },
                { fullName: { contains: search, mode: 'insensitive' as const } },
                { country: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: { id: true, username: true, fullName: true, country: true },
    });

    // Sorted by join date, which is what the list is ordered by on screen and
    // is not a column on `users`.
    users.sort(
      (a, b) => (joinedAtById.get(b.id)?.getTime() ?? 0) - (joinedAtById.get(a.id)?.getTime() ?? 0),
    );

    const total = users.length;
    const pageUsers = users.slice((page - 1) * limit, page * limit);
    const pageIds = pageUsers.map((u) => u.id);

    const [wallets, activeIds, identities] = await Promise.all([
      this.prisma.wallet.findMany({
        where: { userId: { in: pageIds } },
        select: { userId: true, goldBalance: true },
      }),
      this.recentlyActiveIds(pageIds),
      this.profiles.resolvePublicIdentities(pageIds),
    ]);
    const coinsById = new Map(wallets.map((w) => [w.userId, w.goldBalance]));

    return {
      items: pageUsers.map((user) => ({
        userId: user.id,
        username: user.username,
        displayName: identities.get(user.id)?.displayName ?? user.fullName ?? user.username,
        avatarUrl: identities.get(user.id)?.avatarUrl ?? null,
        country: user.country,
        joinedAt: joinedAtById.get(user.id) ?? null,
        // String for the same BigInt reason as everywhere else in this domain.
        coins: (coinsById.get(user.id) ?? BigInt(0)).toString(),
        isActive: activeIds.has(user.id),
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * One member's Overview tab: identity, badge, headline stats and rank.
   *
   * The Activity and Performance tabs are their own endpoints — opening a
   * profile should not pay for an agency-wide ranking computation and a
   * 90-day chart the caller may never look at.
   *
   * Throws if the user is not a member of this agency, so a guessed id reveals
   * nothing about a user who belongs to somebody else.
   */
  async getMember(agencyId: string, userId: string) {
    const relationship = await this.assertMember(agencyId, userId);

    const now = new Date();
    const windowStart = new Date(now.getTime() - TREND_WINDOW_DAYS * DAY_MS);
    const baselineStart = new Date(now.getTime() - 2 * TREND_WINDOW_DAYS * DAY_MS);
    const current = { gte: windowStart, lt: now };
    const baseline = { gte: baselineStart, lt: windowStart };

    const [
      user,
      wallet,
      sentNow,
      sentBefore,
      receivedNow,
      receivedBefore,
      roomsNow,
      roomsBefore,
      activeIds,
      score,
    ] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          username: true,
          fullName: true,
          email: true,
          gender: true,
          preferredLanguage: true,
          country: true,
          createdAt: true,
        },
      }),
      this.prisma.wallet.findUnique({
        where: { userId },
        select: { goldBalance: true, diamondBalance: true },
      }),
      this.giftTotals(userId, 'senderId', current),
      this.giftTotals(userId, 'senderId', baseline),
      this.giftTotals(userId, 'receiverId', current),
      this.giftTotals(userId, 'receiverId', baseline),
      this.roomJoinCount(userId, current),
      this.roomJoinCount(userId, baseline),
      this.recentlyActiveIds([userId]),
      this.scores.rankAgency(agencyId).then((ranked) => ranked.get(userId) ?? null),
    ]);

    const identity = (await this.profiles.resolvePublicIdentities([userId])).get(userId);

    if (!user) {
      throw new NotFoundException('This user is not a member of your agency');
    }

    return {
      profile: {
        userId: user.id,
        username: user.username,
        displayName: identity?.displayName ?? user.fullName ?? user.username,
        fullName: user.fullName,
        avatarUrl: identity?.avatarUrl ?? null,
        email: user.email,
        gender: user.gender,
        language: user.preferredLanguage,
        country: user.country,
        joinedAgencyAt: relationship.effectiveFrom,
        registeredAt: user.createdAt,
        isActive: activeIds.has(userId),
        coins: (wallet?.goldBalance ?? BigInt(0)).toString(),
        earnings: (wallet?.diamondBalance ?? BigInt(0)).toString(),
      },
      badge: await this.loadBadge(userId, score?.topPercent ?? null),
      stats: {
        giftsSent: this.delta(sentNow.count, sentBefore.count),
        coinsSent: this.coinDelta(sentNow.coins, sentBefore.coins),
        giftsReceived: this.delta(receivedNow.count, receivedBefore.count),
        coinsReceived: this.coinDelta(receivedNow.coins, receivedBefore.coins),
        roomsJoined: this.delta(roomsNow, roomsBefore),
      },
      // Null rather than 0: a member missing from the ranking has no rank, and
      // "#0 of 0" would state something untrue.
      summary: {
        rank: score?.rank ?? null,
        totalMembers: score?.totalMembers ?? null,
        engagementScore: score?.score ?? null,
        grade: score
          ? { code: score.grade.code, label: score.grade.label, caption: score.grade.caption }
          : null,
      },
    };
  }

  /** Gift count and coin total for one direction inside a window. */
  private async giftTotals(
    userId: string,
    field: 'senderId' | 'receiverId',
    window: { gte: Date; lt: Date },
  ): Promise<{ count: number; coins: bigint }> {
    const result = await this.prisma.giftTransaction.aggregate({
      where: { [field]: userId, createdAt: window },
      _count: true,
      _sum: { totalCoinValue: true },
    });
    return {
      count: typeof result._count === 'number' ? result._count : 0,
      coins: result._sum.totalCoinValue ?? BigInt(0),
    };
  }

  /** Audio + video room joins inside a window. */
  private async roomJoinCount(userId: string, window: { gte: Date; lt: Date }): Promise<number> {
    const [audio, video] = await Promise.all([
      this.prisma.roomMember.count({ where: { userId, joinedAt: window } }),
      this.prisma.videoRoomMember.count({ where: { userId, joinedAt: window } }),
    ]);
    return audio + video;
  }

  /** Percentage change against the previous same-length window. */
  private percentChange(before: number, after: number): number | null {
    if (before === 0) return null;
    return Math.round(((after - before) / before) * 1000) / 10;
  }

  private delta(value: number, baseline: number): MemberMetricDelta {
    return {
      value,
      changePercent: this.percentChange(baseline, value),
      comparedTo: 'LAST_MONTH',
    };
  }

  private coinDelta(value: bigint, baseline: bigint): MemberCoinMetricDelta {
    return {
      value: value.toString(),
      changePercent: this.percentChange(Number(baseline), Number(value)),
      comparedTo: 'LAST_MONTH',
    };
  }

  /** The member's equipped badge, or null when they have none. */
  private async loadBadge(userId: string, topPercent: number | null) {
    const [equipped, totalBadges] = await Promise.all([
      this.prisma.badgeInventory.findFirst({
        where: { userId, equipped: true },
        select: { badgeCode: true, badge: { select: { name: true, iconUrl: true, tier: true } } },
      }),
      this.prisma.badgeInventory.count({ where: { userId } }),
    ]);
    if (!equipped) return null;
    return {
      code: equipped.badgeCode,
      name: equipped.badge.name,
      iconUrl: equipped.badge.iconUrl,
      tier: equipped.badge.tier,
      topPercent,
      totalBadges,
    };
  }

  /** Members with a session touched inside the active window. */
  private async recentlyActiveIds(userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const since = new Date(Date.now() - ACTIVE_WINDOW_DAYS * DAY_MS);
    const rows = await this.prisma.userSession.findMany({
      where: { userId: { in: userIds }, lastActivityAt: { gte: since } },
      select: { userId: true },
      distinct: ['userId'],
    });
    return new Set(rows.map((r) => r.userId));
  }
}
