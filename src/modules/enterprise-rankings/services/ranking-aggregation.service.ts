import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RankingAuditService } from './ranking-audit.service';
import { RankingCalculationService } from './ranking-calculation.service';
import { RankingConfigurationService } from './ranking-configuration.service';
import { RankingValidationService } from './ranking-validation.service';

export interface AggregateEventInput {
  rankingIds: string[];
  entityId: string;
  entityType: string;
  eventCode: string;
  rawScore: number;
  metadata?: Record<string, any>;
  actorId?: string;
}

/**
 * RankingAggregationService — fan-out engine.
 *
 * A single domain event (GIFT_SENT, LEVEL_UP, …) must update MULTIPLE ranking
 * definitions simultaneously (daily gifters, monthly gifters, family rankings,
 * country rankings, …). This service:
 *  1. Resolves which ranking definitions respond to the event.
 *  2. Applies the score to each via RankingCalculationService.
 *  3. Enforces the maxEntries ceiling per ranking.
 */
@Injectable()
export class RankingAggregationService {
  private readonly logger = new Logger(RankingAggregationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calculationService: RankingCalculationService,
    private readonly configService: RankingConfigurationService,
    private readonly validationService: RankingValidationService,
    private readonly auditService: RankingAuditService,
  ) {}

  /**
   * Apply a score event to all provided ranking IDs concurrently.
   */
  async aggregate(input: AggregateEventInput) {
    const { rankingIds, entityId, entityType, eventCode, rawScore, metadata, actorId } = input;

    if (rankingIds.length === 0) return [];

    const _params = await this.configService.getParameters();
    const results = await Promise.allSettled(
      rankingIds.map((rankingId) =>
        this.calculationService.applyScore({
          rankingId,
          entityId,
          entityType,
          eventCode,
          scoreDelta: rawScore,
          metadata,
          actorId,
        }),
      ),
    );

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      this.logger.error(
        `Aggregation had ${failures.length} failures for event ${eventCode} / entity ${entityId}`,
      );
    }

    return results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<any>).value);
  }

  /**
   * Aggregate by event code — automatically resolves all active rankings
   * whose scoreFormula.eventCodes array includes the given event code.
   */
  async aggregateByEventCode(input: {
    entityId: string;
    entityType: string;
    eventCode: string;
    rawScore: number;
    metadata?: Record<string, any>;
    actorId?: string;
  }) {
    const allActive = await this.prisma.rankingDefinition.findMany({
      where: { status: 'ACTIVE' },
    });

    const matching = allActive.filter((def) => {
      const formula = def.scoreFormula as Record<string, any> | null;
      if (!formula) return false;
      const codes: string[] = formula['eventCodes'] ?? [];
      return codes.includes(input.eventCode);
    });

    if (matching.length === 0) return [];

    return this.aggregate({ ...input, rankingIds: matching.map((d) => d.id) });
  }

  /**
   * Enforce the maxEntries ceiling on a ranking — removes entries beyond limit.
   */
  async enforceMaxEntries(rankingId: string, dateKey: string) {
    const def = await this.prisma.rankingDefinition.findUnique({ where: { id: rankingId } });
    if (!def) return;

    const count = await this.prisma.rankingEntry.count({ where: { rankingId, dateKey } });
    if (count <= def.maxEntries) return;

    const excess = await this.prisma.rankingEntry.findMany({
      where: { rankingId, dateKey },
      orderBy: { rank: 'desc' },
      take: count - def.maxEntries,
    });

    await this.prisma.rankingEntry.deleteMany({
      where: { id: { in: excess.map((e) => e.id) } },
    });

    this.logger.log(
      `Enforced maxEntries (${def.maxEntries}) for ranking ${rankingId}: removed ${excess.length} entries`,
    );
  }
}
