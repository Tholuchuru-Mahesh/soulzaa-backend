import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

const num = (value: unknown): number => Number(value ?? 0);

/**
 * Read models for the engagement dashboards: gifts, treasure boxes, families,
 * Wealth Level, level & achievements, rankings and referrals.
 *
 * Read-only. Progression is owned by the engines and driven by domain events;
 * the console reads the result rather than recomputing it, so what an operator
 * sees is what actually happened to a user's account.
 */
@Injectable()
export class DashboardEngagementService {
  private readonly logger = new Logger(DashboardEngagementService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Gift analytics: volume, value and the most-sent gifts. */
  async giftDashboard(topGifts = 10) {
    const [catalogue, activity, leaders] = await Promise.all([
      this.prisma.gift.count(),
      this.prisma.roomActivity.aggregate({ _sum: { totalGifts: true } }),
      this.prisma.giftTransaction.groupBy({
        by: ['giftId'],
        _sum: { totalCoinValue: true, quantity: true },
        orderBy: { _sum: { totalCoinValue: 'desc' } },
        take: topGifts,
      }),
    ]);

    return {
      catalogueSize: catalogue,
      totalGiftsSent: num(activity._sum.totalGifts),
      topGifts: leaders.map((row) => ({
        giftId: row.giftId,
        quantitySent: num(row._sum?.quantity),
        coinValue: num(row._sum?.totalCoinValue),
      })),
    };
  }

  /** Treasure box monitoring: session state and reward payout. */
  async treasureDashboard() {
    const [sessions, byStatus, boxes, rewards, contributions] = await Promise.all([
      this.prisma.treasureSession.count(),
      this.prisma.treasureSession.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.treasureBox.count(),
      this.prisma.treasureReward.count(),
      this.prisma.treasureContribution.aggregate({ _sum: { amount: true } }),
    ]);

    return {
      totalSessions: sessions,
      sessionsByStatus: byStatus.map((row) => ({ status: row.status, count: row._count._all })),
      totalBoxes: boxes,
      totalRewards: rewards,
      contributedCoins: num(contributions._sum?.amount),
    };
  }

  /** Family management: population, size distribution and the largest families. */
  async familyDashboard(topFamilies = 10) {
    const [families, members, byStatus, largest] = await Promise.all([
      this.prisma.family.count(),
      this.prisma.familyMember.count(),
      this.prisma.family.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.familyMember.groupBy({
        by: ['familyId'],
        _count: { _all: true },
        orderBy: { _count: { familyId: 'desc' } },
        take: topFamilies,
      }),
    ]);

    return {
      totalFamilies: families,
      totalMembers: members,
      averageSize: families > 0 ? Math.round((members / families) * 100) / 100 : 0,
      byStatus: byStatus.map((row) => ({ status: row.status, count: row._count._all })),
      largestFamilies: largest.map((row) => ({
        familyId: row.familyId,
        members: row._count._all,
      })),
    };
  }

  /** Wealth Level management: distribution of users across levels this month. */
  async vipDashboard() {
    const [usersWithProgress, byLevel, levels] = await Promise.all([
      this.prisma.wealthUserProgress.count(),
      this.prisma.wealthUserProgress.groupBy({ by: ['currentLevel'], _count: { _all: true } }),
      this.prisma.wealthLevel.findMany({ select: { level: true, name: true } }),
    ]);

    const levelNameByOrdinal = new Map(levels.map((l) => [l.level, l.name]));

    return {
      totalUsersWithProgress: usersWithProgress,
      activeThisLevelOrAbove: byLevel
        .filter((row) => row.currentLevel > 0)
        .reduce((sum, row) => sum + row._count._all, 0),
      byLevel: byLevel.map((row) => ({
        level: row.currentLevel,
        name: levelNameByOrdinal.get(row.currentLevel) ?? `Level ${row.currentLevel}`,
        users: row._count._all,
      })),
    };
  }

  /** Level & achievement monitoring: progression spread and unlock volume. */
  async progressionDashboard(topLevels = 10) {
    const [tracked, totals, topByLevel, definitions, unlocked, badges] = await Promise.all([
      this.prisma.userLevel.count(),
      this.prisma.userLevel.aggregate({
        _sum: { lifetimeExp: true },
        _avg: { currentLevel: true },
        _max: { currentLevel: true },
      }),
      this.prisma.userLevel.findMany({
        orderBy: { lifetimeExp: 'desc' },
        take: topLevels,
        select: { userId: true, currentLevel: true, lifetimeExp: true },
      }),
      this.prisma.achievementDefinition.count(),
      this.prisma.userAchievement.count(),
      this.prisma.badgeInventory.count(),
    ]);

    return {
      usersWithLevel: tracked,
      totalExpAwarded: num(totals._sum.lifetimeExp),
      averageLevel: Math.round(num(totals._avg?.currentLevel) * 100) / 100,
      highestLevel: num(totals._max?.currentLevel),
      topUsers: topByLevel.map((u) => ({
        userId: u.userId,
        level: u.currentLevel,
        lifetimeExp: num(u.lifetimeExp),
      })),
      achievementDefinitions: definitions,
      achievementsUnlocked: unlocked,
      badgesHeld: badges,
    };
  }

  /** Ranking dashboard: leaderboard inventory and snapshot coverage. */
  async rankingDashboard() {
    const [definitions, byStatus, entries, snapshots] = await Promise.all([
      this.prisma.rankingDefinition.count(),
      this.prisma.rankingDefinition.groupBy({ by: ['category'], _count: { _all: true } }),
      this.prisma.rankingEntry.count(),
      this.prisma.enterpriseRankingSnapshot.count(),
    ]);

    return {
      totalDefinitions: definitions,
      byCategory: byStatus.map((row) => ({ category: row.category, count: row._count._all })),
      totalEntries: entries,
      // Zero here means the nightly snapshot job is not running.
      totalSnapshots: snapshots,
    };
  }

  /** Referral management: funnel from code issued through to qualified. */
  async referralDashboard(topReferrers = 10) {
    const [codes, relationships, byStatus, campaigns, leaders] = await Promise.all([
      this.prisma.referralCode.count(),
      this.prisma.referralRelationship.count(),
      this.prisma.referralRelationship.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.referralCampaign.count(),
      this.prisma.referralRelationship.groupBy({
        by: ['referrerId'],
        _count: { _all: true },
        orderBy: { _count: { referrerId: 'desc' } },
        take: topReferrers,
      }),
    ]);

    return {
      totalCodes: codes,
      totalRelationships: relationships,
      totalCampaigns: campaigns,
      byStatus: byStatus.map((row) => ({ status: row.status, count: row._count._all })),
      topReferrers: leaders.map((row) => ({
        referrerId: row.referrerId,
        referrals: row._count._all,
      })),
    };
  }
}
