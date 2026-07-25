import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RankingAuditService } from './ranking-audit.service';
import { RankingEventService } from './ranking-event.service';
import { RankingStatisticsService } from './ranking-statistics.service';
import { RankingValidationService } from './ranking-validation.service';

export interface TakeSnapshotInput {
  rankingId: string;
  period: string;
  dateKey: string;
  actorId?: string;
}

@Injectable()
export class RankingSnapshotService {
  private readonly logger = new Logger(RankingSnapshotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validationService: RankingValidationService,
    private readonly auditService: RankingAuditService,
    private readonly eventService: RankingEventService,
    private readonly statisticsService: RankingStatisticsService,
  ) {}

  /**
   * Take an immutable snapshot of all current ranking entries for a given
   * ranking definition + period + dateKey.
   */
  async takeSnapshot(input: TakeSnapshotInput) {
    const { rankingId, period, dateKey, actorId } = input;

    await this.validationService.validateRankingDefinitionExists(rankingId);

    // Idempotent check
    const existing = await this.prisma.enterpriseRankingSnapshot.count({
      where: { rankingId, period, dateKey },
    });

    if (existing > 0) {
      this.logger.warn(`Snapshot for ${rankingId} / ${dateKey} already exists — skipping`);
      return { skipped: true, existing };
    }

    // Read current ranking entries
    const entries = await this.prisma.rankingEntry.findMany({
      where: { rankingId, dateKey },
      orderBy: { rank: 'asc' },
    });

    if (entries.length === 0) {
      this.logger.log(`No entries for ranking ${rankingId} on ${dateKey} — empty snapshot`);
      return { skipped: false, count: 0 };
    }

    // Batch create snapshot rows
    await this.prisma.enterpriseRankingSnapshot.createMany({
      data: entries.map((e) => ({
        rankingId,
        period,
        dateKey,
        entityId: e.entityId,
        entityType: e.entityType,
        rank: e.rank,
        previousRank: e.previousRank,
        score: e.score,
        metadata: e.metadata ?? {},
      })),
      skipDuplicates: true,
    });

    const count = entries.length;

    await this.auditService.logAudit('RANKING_SNAPSHOT_CREATED', rankingId, actorId, {
      period,
      dateKey,
      count,
    });

    await this.eventService.publishSnapshotCreated(rankingId, period, dateKey, count);

    this.logger.log(`Snapshot created: ranking=${rankingId} dateKey=${dateKey} count=${count}`);

    return { skipped: false, count };
  }

  /**
   * Take snapshots for ALL active ranking definitions for today's date keys.
   * Called by the scheduler at midnight.
   */
  async takeAllSnapshots(actorId?: string) {
    const definitions = await this.prisma.rankingDefinition.findMany({
      where: { status: 'ACTIVE' },
    });

    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const dailyKey = `${y}${m}${d}`;

    const results = [];
    for (const def of definitions) {
      try {
        const result = await this.takeSnapshot({
          rankingId: def.id,
          period: def.timeWindow,
          dateKey: dailyKey,
          actorId,
        });
        results.push({ rankingId: def.id, ...result });
      } catch (err) {
        this.logger.error(`Failed to snapshot ranking ${def.id}: ${(err as Error).message}`);
      }
    }

    return results;
  }

  async getSnapshots(
    rankingId: string,
    period?: string,
    dateKey?: string,
    limit = 100,
    offset = 0,
  ) {
    const where: any = { rankingId };
    if (period) where.period = period;
    if (dateKey) where.dateKey = dateKey;

    const [items, total] = await Promise.all([
      this.prisma.enterpriseRankingSnapshot.findMany({
        where,
        orderBy: [{ dateKey: 'desc' }, { rank: 'asc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.enterpriseRankingSnapshot.count({ where }),
    ]);

    return { items, total, limit, offset };
  }

  async getEntitySnapshotHistory(entityId: string, rankingId: string, limit = 30) {
    return this.prisma.enterpriseRankingSnapshot.findMany({
      where: { entityId, rankingId },
      orderBy: { dateKey: 'desc' },
      take: limit,
    });
  }
}
