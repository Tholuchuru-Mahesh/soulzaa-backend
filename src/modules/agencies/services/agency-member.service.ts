import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import { AgencyCommunityService } from './agency-community.service';

/** A member counts as active if they have used the app inside this window. */
const ACTIVE_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE_SIZE = 100;
const TIMELINE_SIZE = 20;

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
  ) {}

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
   * One member's profile, activity and performance — the three tabs.
   *
   * Throws if the user is not a member of this agency, so a guessed id reveals
   * nothing about a user who belongs to somebody else.
   */
  async getMember(agencyId: string, userId: string) {
    const relationship = await this.prisma.agencyRelationship.findUnique({
      where: { agencyId_hostId: { agencyId, hostId: userId } },
      select: { effectiveFrom: true, status: true },
    });
    if (!relationship || relationship.status !== 'ACTIVE') {
      throw new NotFoundException('This user is not a member of your agency');
    }

    const now = new Date();
    const since = new Date(now.getTime() - ACTIVE_WINDOW_DAYS * DAY_MS);

    const [user, wallet, sent, received, roomsJoined, activeIds, timeline] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true, fullName: true, country: true, createdAt: true },
      }),
      this.prisma.wallet.findUnique({
        where: { userId },
        select: { goldBalance: true, diamondBalance: true },
      }),
      this.prisma.giftTransaction.aggregate({
        where: { senderId: userId },
        _count: true,
        _sum: { totalCoinValue: true },
      }),
      this.prisma.giftTransaction.aggregate({
        where: { receiverId: userId },
        _count: true,
        _sum: { totalCoinValue: true },
      }),
      this.prisma.roomLog.count({ where: { actorId: userId, action: 'JOINED' } }),
      this.recentlyActiveIds([userId]),
      this.buildTimeline(userId),
    ]);

    const identity = (await this.profiles.resolvePublicIdentities([userId])).get(userId);

    if (!user) {
      throw new NotFoundException('This user is not a member of your agency');
    }

    const giftsSent = sent._count;
    const giftsReceived = received._count;

    return {
      profile: {
        userId: user.id,
        username: user.username,
        displayName: identity?.displayName ?? user.fullName ?? user.username,
        avatarUrl: identity?.avatarUrl ?? null,
        country: user.country,
        joinedAgencyAt: relationship.effectiveFrom,
        registeredAt: user.createdAt,
        isActive: activeIds.has(userId),
        coins: (wallet?.goldBalance ?? BigInt(0)).toString(),
        earnings: (wallet?.diamondBalance ?? BigInt(0)).toString(),
      },
      activity: {
        // "Total activities" on screen is gifts either way plus room joins —
        // the events this platform actually records for a member.
        totalActivities: giftsSent + giftsReceived + roomsJoined,
        giftsSent,
        giftsReceived,
        roomsJoined,
        activeSince: since,
        timeline,
      },
      performance: {
        giftsSent,
        coinsSent: (sent._sum.totalCoinValue ?? BigInt(0)).toString(),
        giftsReceived,
        coinsReceived: (received._sum.totalCoinValue ?? BigInt(0)).toString(),
        roomsJoined,
      },
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

  /**
   * The activity timeline: the member's recent gifts and room joins, merged.
   *
   * Both sources are trimmed before merging and the merged list is sorted
   * again before its own trim — otherwise the newest entries of one kind would
   * be dropped in favour of older entries of the other.
   */
  private async buildTimeline(userId: string) {
    const [gifts, joins] = await Promise.all([
      this.prisma.giftTransaction.findMany({
        where: { senderId: userId },
        orderBy: { createdAt: 'desc' },
        take: TIMELINE_SIZE,
        select: { id: true, createdAt: true, totalCoinValue: true, contextType: true },
      }),
      this.prisma.roomLog.findMany({
        where: { actorId: userId, action: 'JOINED' },
        orderBy: { createdAt: 'desc' },
        take: TIMELINE_SIZE,
        select: { id: true, createdAt: true, roomId: true },
      }),
    ]);

    const entries = [
      ...gifts.map((gift) => ({
        id: gift.id,
        kind: 'GIFT_SENT' as const,
        title: 'Sent a gift',
        detail: `${gift.totalCoinValue.toString()} coins`,
        context: gift.contextType,
        occurredAt: gift.createdAt,
      })),
      ...joins.map((join) => ({
        id: join.id,
        kind: 'ROOM_JOINED' as const,
        title: 'Joined a room',
        detail: null,
        context: null,
        occurredAt: join.createdAt,
      })),
    ];

    entries.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    return entries.slice(0, TIMELINE_SIZE);
  }
}
