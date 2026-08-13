import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import type {
  CommunityOverview,
  GrowthPoint,
  GrowthRange,
  GrowthSeries,
  MetricDelta,
} from '../interfaces/agency-dashboard.interface';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many daily points each chart range plots. */
const RANGE_DAYS: Record<GrowthRange, number> = {
  week: 7,
  month: 30,
  quarter: 90,
};

/**
 * Answers "how big is my community, and is it growing" for one agency.
 *
 * Membership history is read from the relationship's own date window
 * (`effectiveFrom` / `effectiveUntil`) rather than from `status`, because
 * `status` only describes today. A host who left last week is TERMINATED now
 * but was a member a month ago, and a growth chart that ignored that would
 * redraw history every time someone left.
 */
@Injectable()
export class AgencyCommunityService {
  constructor(private readonly prisma: PrismaService) {}

  /** The hosts currently under `agencyId`. */
  async getActiveHostIds(agencyId: string): Promise<string[]> {
    const rows = await this.prisma.agencyRelationship.findMany({
      where: { agencyId, status: 'ACTIVE' },
      select: { hostId: true },
    });
    return rows.map((row) => row.hostId);
  }

  /**
   * Community size and activity, each against the same window one period back.
   */
  async getOverview(agencyId: string, now: Date): Promise<CommunityOverview> {
    const hostIds = await this.getActiveHostIds(agencyId);

    const dayAgo = new Date(now.getTime() - DAY_MS);
    const twoDaysAgo = new Date(now.getTime() - 2 * DAY_MS);
    const monthAgo = new Date(now.getTime() - 30 * DAY_MS);
    const twoMonthsAgo = new Date(now.getTime() - 60 * DAY_MS);

    const [totalNow, totalThen, dailyNow, dailyThen, monthlyNow, monthlyThen] = await Promise.all([
      this.countMembersAt(agencyId, now),
      this.countMembersAt(agencyId, monthAgo),
      this.countActiveHosts(hostIds, dayAgo, now),
      this.countActiveHosts(hostIds, twoDaysAgo, dayAgo),
      this.countActiveHosts(hostIds, monthAgo, now),
      this.countActiveHosts(hostIds, twoMonthsAgo, monthAgo),
    ]);

    return {
      totalUsers: this.toMetric(totalNow, totalThen, 'LAST_MONTH'),
      dailyActive: this.toMetric(dailyNow, dailyThen, 'YESTERDAY'),
      monthlyActive: this.toMetric(monthlyNow, monthlyThen, 'LAST_MONTH'),
    };
  }

  /** Daily member count across the trailing window for `range`. */
  async getGrowth(agencyId: string, range: GrowthRange, now: Date): Promise<GrowthSeries> {
    const days = RANGE_DAYS[range];
    const firstDay = new Date(now.getTime() - (days - 1) * DAY_MS);

    // Every relationship that could have been open at any point in the window,
    // read once and counted in memory. One COUNT per day would be up to 90
    // round-trips to draw a single card.
    const relationships = await this.prisma.agencyRelationship.findMany({
      where: {
        agencyId,
        effectiveFrom: { lte: now },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: firstDay } }],
      },
      select: { effectiveFrom: true, effectiveUntil: true },
    });

    const points: GrowthPoint[] = [];
    for (let offset = 0; offset < days; offset += 1) {
      const at = new Date(firstDay.getTime() + offset * DAY_MS);
      const value = relationships.filter(
        (r) => r.effectiveFrom <= at && (r.effectiveUntil === null || r.effectiveUntil > at),
      ).length;
      points.push({ date: at.toISOString().slice(0, 10), value });
    }

    return { range, points };
  }

  /** Members whose relationship window covers `at`. */
  private countMembersAt(agencyId: string, at: Date): Promise<number> {
    return this.prisma.agencyRelationship.count({
      where: {
        agencyId,
        effectiveFrom: { lte: at },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: at } }],
      },
    });
  }

  /**
   * Distinct hosts from `hostIds` with session activity inside `[since, until)`.
   *
   * Restricted to the agency's own hosts, so this can never leak another
   * agency's activity even if the id set were built wrongly upstream.
   */
  private async countActiveHosts(hostIds: string[], since: Date, until: Date): Promise<number> {
    if (hostIds.length === 0) return 0;

    const rows = await this.prisma.userSession.findMany({
      where: {
        userId: { in: hostIds },
        lastActivityAt: { gte: since, lt: until },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    return rows.length;
  }

  private toMetric(
    value: number,
    baseline: number,
    comparedTo: MetricDelta['comparedTo'],
  ): MetricDelta {
    return { value, changePercent: this.percentChange(baseline, value), comparedTo };
  }

  /** Null on a zero baseline — growth from nothing has no percentage. */
  private percentChange(before: number, after: number): number | null {
    if (before === 0) return null;
    return Math.round(((after - before) / before) * 1000) / 10;
  }
}
