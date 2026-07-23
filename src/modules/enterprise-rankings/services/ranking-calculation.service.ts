import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RankingAuditService } from './ranking-audit.service';
import { RankingEventService } from './ranking-event.service';
import { RankingStatisticsService } from './ranking-statistics.service';

export interface CalculateScoreInput {
  entityId: string;
  entityType: string;
  rankingId: string;
  eventCode: string;
  scoreDelta: number;
  metadata?: Record<string, any>;
  actorId?: string;
}

export interface CalculationResult {
  entityId: string;
  scoreBefore: bigint;
  scoreAfter: bigint;
  rankBefore: number | null;
  rankAfter: number | null;
  promoted: boolean;
  demoted: boolean;
}

/**
 * RankingCalculationService — applies score deltas to a ranking entry and
 * reassigns rank positions.
 *
 * Scoring rules are stored as JSON on the RankingDefinition.scoreFormula:
 *   { "multiplier": 1.5, "cap": 100000 }
 * No hardcoded formulas. The calculation engine reads the formula and applies
 * it to the incoming scoreDelta. Formula interpretation:
 *   - multiplier: multiplies the raw scoreDelta before applying
 *   - cap: maximum score a single event can contribute
 *   - bonus: flat bonus added when a condition matches
 */
@Injectable()
export class RankingCalculationService {
  private readonly logger = new Logger(RankingCalculationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly statisticsService: RankingStatisticsService,
    private readonly auditService: RankingAuditService,
    private readonly eventService: RankingEventService,
  ) {}

  async applyScore(input: CalculateScoreInput): Promise<CalculationResult> {
    const { entityId, entityType, rankingId, eventCode, metadata = {} } = input;

    // Get ranking definition and its score formula
    const definition = await this.prisma.rankingDefinition.findUnique({
      where: { id: rankingId },
    });

    if (!definition || definition.status !== 'ACTIVE') {
      this.logger.warn(`Ranking ${rankingId} not active — skipping score calculation`);
      return {
        entityId,
        scoreBefore: BigInt(0),
        scoreAfter: BigInt(0),
        rankBefore: null,
        rankAfter: null,
        promoted: false,
        demoted: false,
      };
    }

    const adjustedDelta = this.applyFormula(
      definition.scoreFormula as Record<string, any> | null,
      input.scoreDelta,
      metadata,
    );

    // Upsert the ranking entry
    const dateKey = this.buildDateKey(definition.timeWindow);

    const existing = await this.prisma.rankingEntry.findUnique({
      where: { rankingId_entityId_dateKey: { rankingId, entityId, dateKey } },
    });

    const scoreBefore = existing?.score ?? BigInt(0);
    const rankBefore = existing?.rank ?? null;
    const newScore = BigInt(Math.max(0, Number(scoreBefore) + adjustedDelta));

    const entry = await this.prisma.rankingEntry.upsert({
      where: { rankingId_entityId_dateKey: { rankingId, entityId, dateKey } },
      update: { score: newScore, updatedAt: new Date() },
      create: {
        rankingId,
        entityId,
        entityType,
        score: newScore,
        rank: 0, // placeholder — reranked after
        period: definition.timeWindow,
        dateKey,
      },
    });

    // Re-rank all entries for this ranking+dateKey by score descending
    const rankAfter = await this.rerank(rankingId, dateKey, entityId);

    // Write history
    await this.prisma.rankingHistory.create({
      data: {
        rankingId,
        entityId,
        entityType,
        eventCode,
        scoreDelta: BigInt(adjustedDelta),
        scoreBefore,
        scoreAfter: newScore,
        rankBefore,
        rankAfter,
        metadata,
      },
    });

    const promoted = rankBefore !== null && rankAfter !== null && rankAfter < rankBefore;
    const demoted = rankBefore !== null && rankAfter !== null && rankAfter > rankBefore;

    // Update statistics
    await this.statisticsService.incrementScoreAwarded(definition.category, BigInt(adjustedDelta));
    if (promoted) await this.statisticsService.incrementPromotions(definition.category);
    if (demoted) await this.statisticsService.incrementDemotions(definition.category);

    // Publish ranking.updated event
    await this.eventService.publishRankingUpdated(
      rankingId,
      entityId,
      entityType,
      rankAfter ?? 0,
      rankBefore,
      adjustedDelta,
    );

    // Audit
    const auditAction = promoted ? 'RANKING_PROMOTED' : demoted ? 'RANKING_DEMOTED' : 'RANKING_UPDATED';
    await this.auditService.logAudit(auditAction, entityId, input.actorId, {
      rankingId,
      eventCode,
      scoreDelta: adjustedDelta,
      scoreBefore: Number(scoreBefore),
      scoreAfter: Number(newScore),
      rankBefore,
      rankAfter,
    });

    return {
      entityId,
      scoreBefore,
      scoreAfter: newScore,
      rankBefore,
      rankAfter,
      promoted,
      demoted,
    };
  }

  /**
   * Admin-level manual score adjustment (can set or increment).
   */
  async manualAdjust(
    rankingId: string,
    entityId: string,
    entityType: string,
    newAbsoluteScore: number,
    actorId: string,
    reason: string,
  ) {
    const definition = await this.prisma.rankingDefinition.findUnique({ where: { id: rankingId } });
    if (!definition) throw new Error(`Ranking ${rankingId} not found`);

    const dateKey = this.buildDateKey(definition.timeWindow);
    const newScore = BigInt(Math.max(0, newAbsoluteScore));

    const existing = await this.prisma.rankingEntry.findUnique({
      where: { rankingId_entityId_dateKey: { rankingId, entityId, dateKey } },
    });

    const scoreBefore = existing?.score ?? BigInt(0);

    await this.prisma.rankingEntry.upsert({
      where: { rankingId_entityId_dateKey: { rankingId, entityId, dateKey } },
      update: { score: newScore, updatedAt: new Date() },
      create: { rankingId, entityId, entityType, score: newScore, rank: 0, period: definition.timeWindow, dateKey },
    });

    await this.rerank(rankingId, dateKey, entityId);

    await this.prisma.rankingHistory.create({
      data: {
        rankingId,
        entityId,
        entityType,
        eventCode: 'ADMIN_ADJUSTMENT',
        scoreDelta: newScore - scoreBefore,
        scoreBefore,
        scoreAfter: newScore,
        metadata: { reason, actorId },
      },
    });

    await this.auditService.logAudit('RANKING_SCORE_ADJUSTED', entityId, actorId, {
      rankingId,
      scoreBefore: Number(scoreBefore),
      scoreAfter: Number(newScore),
      reason,
    });
  }

  /**
   * Applies the JSON formula to the raw delta.
   */
  private applyFormula(
    formula: Record<string, any> | null,
    rawDelta: number,
    _metadata: Record<string, any>,
  ): number {
    if (!formula) return rawDelta;

    let delta = rawDelta;

    if (formula['multiplier']) {
      delta = Math.round(delta * Number(formula['multiplier']));
    }
    if (formula['cap'] !== undefined) {
      delta = Math.min(delta, Number(formula['cap']));
    }
    if (formula['bonus'] !== undefined) {
      delta += Number(formula['bonus']);
    }

    return Math.max(0, Math.round(delta));
  }

  /**
   * Re-ranks all entries for the given ranking+dateKey by descending score.
   * Returns the new rank of entityId.
   */
  private async rerank(rankingId: string, dateKey: string, entityId: string): Promise<number | null> {
    // Fetch all entries sorted by score desc
    const allEntries = await this.prisma.rankingEntry.findMany({
      where: { rankingId, dateKey },
      orderBy: { score: 'desc' },
    });

    // Batch update ranks using a transaction
    await this.prisma.$transaction(
      allEntries.map((e, idx) =>
        this.prisma.rankingEntry.update({
          where: { id: e.id },
          data: {
            previousRank: e.rank === 0 ? null : e.rank,
            rank: idx + 1,
            rankDelta: e.rank === 0 ? 0 : e.rank - (idx + 1),
          },
        }),
      ),
    );

    const target = allEntries.findIndex((e) => e.entityId === entityId);
    return target !== -1 ? target + 1 : null;
  }

  private buildDateKey(timeWindow: string): string {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const h = String(now.getUTCHours()).padStart(2, '0');

    switch (timeWindow) {
      case 'HOURLY': return `${y}${m}${d}${h}`;
      case 'DAILY': return `${y}${m}${d}`;
      case 'WEEKLY': {
        const w = this.isoWeek(now);
        return `${y}W${String(w).padStart(2, '0')}`;
      }
      case 'MONTHLY': return `${y}${m}`;
      case 'QUARTERLY': return `${y}Q${Math.ceil(parseInt(m) / 3)}`;
      case 'YEARLY': return `${y}`;
      case 'SEASON': return `season_${y}`;
      case 'LIFETIME':
      case 'REALTIME':
      default: return 'alltime';
    }
  }

  private isoWeek(date: Date): number {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }
}
