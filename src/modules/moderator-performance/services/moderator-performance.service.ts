import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export type ModerationActionType =
  | 'WARN'
  | 'MUTE'
  | 'KICK'
  | 'BAN'
  | 'REPORT_REVIEWED'
  | 'REPORT_RESOLVED'
  | 'REPORT_ESCALATED'
  | 'ROOM_VISITED';

const SCORE_WEIGHTS: Record<ModerationActionType, number> = {
  REPORT_RESOLVED: 2,
  REPORT_REVIEWED: 1,
  REPORT_ESCALATED: 1.5,
  BAN: 1.5,
  KICK: 1,
  MUTE: 1,
  WARN: 0.5,
  ROOM_VISITED: 0.25,
};

@Injectable()
export class ModeratorPerformanceService {
  private readonly logger = new Logger(ModeratorPerformanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  private todayKey(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  /** Increments the relevant counter for today's stats row. */
  async recordAction(moderatorId: string, action: ModerationActionType): Promise<void> {
    const dateKey = this.todayKey();
    const fieldMap: Partial<Record<ModerationActionType, string>> = {
      WARN: 'warningsIssued',
      MUTE: 'mutesIssued',
      KICK: 'kicksIssued',
      BAN: 'bansIssued',
      REPORT_REVIEWED: 'reportsReviewed',
      REPORT_RESOLVED: 'reportsResolved',
      REPORT_ESCALATED: 'reportsEscalated',
      ROOM_VISITED: 'roomsVisited',
    };

    const field = fieldMap[action];
    if (!field) return;

    try {
      // Upsert today's stats row and increment the relevant counter.
      const existing = await this.prisma.moderatorDailyStats.findUnique({
        where: { moderatorId_dateKey: { moderatorId, dateKey } },
      });

      if (existing) {
        await this.prisma.moderatorDailyStats.update({
          where: { moderatorId_dateKey: { moderatorId, dateKey } },
          data: { [field]: { increment: 1 } },
        });
      } else {
        await this.prisma.moderatorDailyStats.create({
          data: { moderatorId, dateKey, [field]: 1 },
        });
      }

      // Recalculate performance score asynchronously (best-effort).
      void this.recalculateScore(moderatorId, dateKey);
    } catch (err) {
      this.logger.error(`Failed to record action for ${moderatorId}: ${(err as Error).message}`);
    }
  }

  private async recalculateScore(moderatorId: string, dateKey: string): Promise<void> {
    const stats = await this.prisma.moderatorDailyStats.findUnique({
      where: { moderatorId_dateKey: { moderatorId, dateKey } },
    });
    if (!stats) return;

    const score = Math.min(
      100,
      stats.warningsIssued * SCORE_WEIGHTS.WARN +
        stats.mutesIssued * SCORE_WEIGHTS.MUTE +
        stats.kicksIssued * SCORE_WEIGHTS.KICK +
        stats.bansIssued * SCORE_WEIGHTS.BAN +
        stats.reportsReviewed * SCORE_WEIGHTS.REPORT_REVIEWED +
        stats.reportsResolved * SCORE_WEIGHTS.REPORT_RESOLVED +
        stats.reportsEscalated * SCORE_WEIGHTS.REPORT_ESCALATED +
        stats.roomsVisited * SCORE_WEIGHTS.ROOM_VISITED,
    );

    await this.prisma.moderatorDailyStats.update({
      where: { moderatorId_dateKey: { moderatorId, dateKey } },
      data: { performanceScore: score },
    });
  }

  async getDaily(moderatorId: string, dateKey?: string) {
    const key = dateKey ?? this.todayKey();
    return this.prisma.moderatorDailyStats.findUnique({
      where: { moderatorId_dateKey: { moderatorId, dateKey: key } },
    });
  }

  async getRange(moderatorId: string, from: string, to: string) {
    return this.prisma.moderatorDailyStats.findMany({
      where: { moderatorId, dateKey: { gte: from, lte: to } },
      orderBy: { dateKey: 'asc' },
    });
  }

  async getSummary(moderatorId: string) {
    const today = this.todayKey();
    const d = new Date();
    // Start of current week (Monday)
    const dow = d.getUTCDay() || 7;
    const weekStart = new Date(d);
    weekStart.setUTCDate(d.getUTCDate() - dow + 1);
    const weekKey = `${weekStart.getUTCFullYear()}-${String(weekStart.getUTCMonth() + 1).padStart(2, '0')}-${String(weekStart.getUTCDate()).padStart(2, '0')}`;

    const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;

    const [todayStats, weekStats, monthStats] = await Promise.all([
      this.getDaily(moderatorId, today),
      this.getRange(moderatorId, weekKey, today),
      this.getRange(moderatorId, monthKey, today),
    ]);

    const aggregate = (
      rows: Array<{
        reportsReviewed: number;
        reportsResolved: number;
        bansIssued: number;
        kicksIssued: number;
        mutesIssued: number;
        warningsIssued: number;
        roomsVisited: number;
        performanceScore: number;
      }>,
    ) =>
      rows.reduce(
        (acc, r) => ({
          reportsReviewed: acc.reportsReviewed + r.reportsReviewed,
          reportsResolved: acc.reportsResolved + r.reportsResolved,
          bansIssued: acc.bansIssued + r.bansIssued,
          kicksIssued: acc.kicksIssued + r.kicksIssued,
          mutesIssued: acc.mutesIssued + r.mutesIssued,
          warningsIssued: acc.warningsIssued + r.warningsIssued,
          roomsVisited: acc.roomsVisited + r.roomsVisited,
          avgScore:
            rows.length > 0
              ? rows.reduce(
                  (s: number, x: { performanceScore: number }) => s + x.performanceScore,
                  0,
                ) / rows.length
              : 0,
        }),
        {
          reportsReviewed: 0,
          reportsResolved: 0,
          bansIssued: 0,
          kicksIssued: 0,
          mutesIssued: 0,
          warningsIssued: 0,
          roomsVisited: 0,
          avgScore: 0,
        },
      );

    return {
      today: todayStats,
      weekSummary: aggregate(weekStats),
      monthSummary: aggregate(monthStats),
    };
  }

  async getAllModeratorStats(dateKey?: string) {
    const key = dateKey ?? this.todayKey();
    return this.prisma.moderatorDailyStats.findMany({
      where: { dateKey: key },
      orderBy: { performanceScore: 'desc' },
    });
  }
}
