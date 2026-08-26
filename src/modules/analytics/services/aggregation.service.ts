import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';

/** Coerces Prisma's BigInt/Decimal sums to a plain number for JSON reporting. */
const num = (value: unknown): number => Number(value ?? 0);

@Injectable()
export class AggregationService {
  private readonly logger = new Logger(AggregationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aggregates key analytical metrics across various database domains.
   * Strictly read-only, NO modifications to source domains.
   *
   * An unknown domain returns an empty metric set rather than a placeholder
   * figure — a fabricated number is worse than an absent one on a dashboard,
   * because it reads as real.
   */
  async aggregateDomainMetrics(domain: string): Promise<Record<string, number>> {
    this.logger.log(`Aggregating metrics for domain: ${domain}`);

    const key = domain.toUpperCase();
    const handler = this.handlers[key];
    if (!handler) {
      this.logger.warn(`No aggregation defined for domain '${domain}' — returning no metrics`);
      return {};
    }
    return handler();
  }

  /** Domains this engine can report on. */
  supportedDomains(): string[] {
    return Object.keys(this.handlers).sort();
  }

  private readonly handlers: Record<string, () => Promise<Record<string, number>>> = {
    PLATFORM_OVERVIEW: () => this.platformOverview(),
    GROWTH: () => this.platformOverview(),
    USER_GROWTH: () => this.userGrowth(),
    RETENTION: () => this.retention(),
    WALLET: () => this.wallet(),
    FINANCIAL: () => this.financial(),
    REVENUE: () => this.revenue(),
    GIFT: () => this.gift(),
    TREASURE_BOX: () => this.treasureBox(),
    WITHDRAWAL: () => this.withdrawal(),
    AGENCY: () => this.agency(),
    COIN_SELLER: () => this.coinSeller(),
    FAMILY: () => this.family(),
    VIP: () => this.vip(),
    LEVEL: () => this.level(),
    ACHIEVEMENT: () => this.achievement(),
    RANKING: () => this.ranking(),
    EVENT: () => this.event(),
    TASK: () => this.task(),
    REFERRAL: () => this.referral(),
    NOTIFICATION: () => this.notification(),
    MODERATION: () => this.moderation(),
  };

  private async platformOverview(): Promise<Record<string, number>> {
    const [total, active] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { status: 'ACTIVE' } }),
    ]);
    return { total_users: total, active_users: active };
  }

  private async userGrowth(): Promise<Record<string, number>> {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [total, day, week, month] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { createdAt: { gte: dayAgo } } }),
      this.prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
      this.prisma.user.count({ where: { createdAt: { gte: monthAgo } } }),
    ]);
    return {
      total_users: total,
      new_users_24h: day,
      new_users_7d: week,
      new_users_30d: month,
    };
  }

  private async retention(): Promise<Record<string, number>> {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Activity comes from sessions — User has no activity timestamp. Counting
    // distinct users, since one person may hold several sessions.
    const activeSince = async (since: Date) =>
      (
        await this.prisma.userSession.findMany({
          where: { lastActivityAt: { gte: since } },
          select: { userId: true },
          distinct: ['userId'],
        })
      ).length;

    const [total, dau, wau, mau] = await Promise.all([
      this.prisma.user.count(),
      activeSince(dayAgo),
      activeSince(weekAgo),
      activeSince(monthAgo),
    ]);
    return {
      total_users: total,
      daily_active_users: dau,
      weekly_active_users: wau,
      monthly_active_users: mau,
      // Stickiness — the conventional DAU/MAU ratio, as a percentage.
      dau_mau_ratio_pct: mau > 0 ? Math.round((dau / mau) * 100) : 0,
    };
  }

  private async wallet(): Promise<Record<string, number>> {
    const [sum, wallets] = await Promise.all([
      this.prisma.wallet.aggregate({ _sum: { availableBalance: true } }),
      this.prisma.wallet.count(),
    ]);
    return {
      total_wallet_balance: num(sum._sum.availableBalance),
      total_wallets: wallets,
    };
  }

  private async financial(): Promise<Record<string, number>> {
    const [wallet, revenue, withdrawal] = await Promise.all([
      this.wallet(),
      this.revenue(),
      this.withdrawal(),
    ]);
    return { ...wallet, ...revenue, ...withdrawal };
  }

  private async revenue(): Promise<Record<string, number>> {
    const [totals, count] = await Promise.all([
      this.prisma.revenueDistribution.aggregate({
        _sum: {
          totalCoinValue: true,
          hostEarningsCoins: true,
          platformEarningsCoins: true,
        },
      }),
      this.prisma.revenueDistribution.count(),
    ]);
    return {
      total_distributions: count,
      total_revenue_coins: num(totals._sum.totalCoinValue),
      host_earnings_coins: num(totals._sum.hostEarningsCoins),
      platform_earnings_coins: num(totals._sum.platformEarningsCoins),
    };
  }

  private async gift(): Promise<Record<string, number>> {
    const totals = await this.prisma.roomActivity.aggregate({ _sum: { totalGifts: true } });
    return { total_gifts_sent: num(totals._sum.totalGifts) };
  }

  private async treasureBox(): Promise<Record<string, number>> {
    const [sessions, boxes, rewards] = await Promise.all([
      this.prisma.treasureSession.count(),
      this.prisma.treasureBox.count(),
      this.prisma.treasureReward.count(),
    ]);
    return {
      total_treasure_sessions: sessions,
      total_treasure_boxes: boxes,
      total_treasure_rewards: rewards,
    };
  }

  private async withdrawal(): Promise<Record<string, number>> {
    const [requests, completed, pending, totals] = await Promise.all([
      this.prisma.withdrawalRequest.count(),
      this.prisma.withdrawalRequest.count({ where: { status: 'COMPLETED' } }),
      this.prisma.withdrawalRequest.count({ where: { status: 'PENDING' } }),
      this.prisma.withdrawalRequest.aggregate({
        _sum: { amountCoins: true },
        where: { status: 'COMPLETED' },
      }),
    ]);
    return {
      total_withdrawal_requests: requests,
      completed_withdrawals: completed,
      pending_withdrawals: pending,
      withdrawn_coins: num(totals._sum.amountCoins),
    };
  }

  private async agency(): Promise<Record<string, number>> {
    const [relationships, settlements, totals] = await Promise.all([
      this.prisma.agencyRelationship.count(),
      this.prisma.agencySettlement.count(),
      this.prisma.agencySettlement.aggregate({
        _sum: { hostEarningsCoins: true, agencyCommissionCoins: true },
      }),
    ]);
    return {
      total_agency_relationships: relationships,
      total_agency_settlements: settlements,
      agency_host_earnings_coins: num(totals._sum.hostEarningsCoins),
      agency_commission_coins: num(totals._sum.agencyCommissionCoins),
    };
  }

  private async coinSeller(): Promise<Record<string, number>> {
    const [relationships, settlements, totals] = await Promise.all([
      this.prisma.coinSellerRelationship.count(),
      this.prisma.coinSellerSettlement.count(),
      this.prisma.coinSellerSettlement.aggregate({
        _sum: { purchaseAmountCoins: true, sellerCommissionCoins: true },
      }),
    ]);
    return {
      total_seller_relationships: relationships,
      total_seller_settlements: settlements,
      seller_purchase_coins: num(totals._sum.purchaseAmountCoins),
      seller_commission_coins: num(totals._sum.sellerCommissionCoins),
    };
  }

  private async family(): Promise<Record<string, number>> {
    const [families, members] = await Promise.all([
      this.prisma.family.count(),
      this.prisma.familyMember.count(),
    ]);
    return {
      total_families: families,
      total_family_members: members,
      average_family_size: families > 0 ? Math.round((members / families) * 100) / 100 : 0,
    };
  }

  private async vip(): Promise<Record<string, number>> {
    const [usersWithProgress, activeLevels] = await Promise.all([
      this.prisma.wealthUserProgress.count(),
      this.prisma.wealthUserProgress.count({ where: { currentLevel: { gt: 0 } } }),
    ]);
    return {
      total_wealth_progress_rows: usersWithProgress,
      active_wealth_levels: activeLevels,
    };
  }

  private async level(): Promise<Record<string, number>> {
    const [tracked, totals] = await Promise.all([
      this.prisma.userLevel.count(),
      this.prisma.userLevel.aggregate({
        _sum: { lifetimeExp: true },
        _avg: { currentLevel: true },
      }),
    ]);
    return {
      users_with_level: tracked,
      total_exp_awarded: num(totals._sum?.lifetimeExp),
      average_level: Math.round(num(totals._avg?.currentLevel) * 100) / 100,
    };
  }

  private async achievement(): Promise<Record<string, number>> {
    const [definitions, unlocked, badges] = await Promise.all([
      this.prisma.achievementDefinition.count(),
      this.prisma.userAchievement.count(),
      this.prisma.badgeInventory.count(),
    ]);
    return {
      total_achievement_definitions: definitions,
      total_achievements_unlocked: unlocked,
      total_badges_held: badges,
    };
  }

  private async ranking(): Promise<Record<string, number>> {
    const [definitions, entries, snapshots] = await Promise.all([
      this.prisma.rankingDefinition.count(),
      this.prisma.rankingEntry.count(),
      this.prisma.enterpriseRankingSnapshot.count(),
    ]);
    return {
      total_ranking_definitions: definitions,
      total_ranking_entries: entries,
      total_ranking_snapshots: snapshots,
    };
  }

  private async event(): Promise<Record<string, number>> {
    const [definitions, active, registrations, participants] = await Promise.all([
      this.prisma.eventDefinition.count(),
      this.prisma.eventDefinition.count({ where: { status: 'ACTIVE' } }),
      this.prisma.eventRegistration.count(),
      this.prisma.eventParticipant.count(),
    ]);
    return {
      total_events: definitions,
      active_events: active,
      total_event_registrations: registrations,
      total_event_participants: participants,
    };
  }

  private async task(): Promise<Record<string, number>> {
    const [definitions, missions, progress, completed] = await Promise.all([
      this.prisma.taskDefinition.count(),
      this.prisma.missionDefinition.count(),
      this.prisma.taskProgress.count(),
      this.prisma.taskProgress.count({ where: { isCompleted: true } }),
    ]);
    return {
      total_task_definitions: definitions,
      total_mission_definitions: missions,
      total_task_progress_records: progress,
      completed_tasks: completed,
    };
  }

  private async referral(): Promise<Record<string, number>> {
    const [codes, relationships, qualified] = await Promise.all([
      this.prisma.referralCode.count(),
      this.prisma.referralRelationship.count(),
      this.prisma.referralRelationship.count({ where: { status: 'QUALIFIED' } }),
    ]);
    return {
      total_referral_codes: codes,
      total_referral_relationships: relationships,
      qualified_referrals: qualified,
    };
  }

  private async notification(): Promise<Record<string, number>> {
    const [notifications, delivered, failed] = await Promise.all([
      this.prisma.enterpriseNotification.count(),
      this.prisma.notificationHistory.count({ where: { status: 'SENT' } }),
      this.prisma.notificationHistory.count({ where: { status: 'FAILED' } }),
    ]);
    return {
      total_notifications_sent: notifications,
      total_deliveries: delivered,
      failed_deliveries: failed,
    };
  }

  private async moderation(): Promise<Record<string, number>> {
    const [suspended, locked, banned] = await Promise.all([
      this.prisma.user.count({ where: { status: 'SUSPENDED' } }),
      this.prisma.user.count({ where: { status: 'LOCKED' } }),
      this.prisma.user.count({ where: { status: 'BANNED' } }),
    ]);
    return {
      suspended_accounts: suspended,
      locked_accounts: locked,
      banned_accounts: banned,
    };
  }
}
