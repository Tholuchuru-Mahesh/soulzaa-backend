import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RankingAuditService } from './ranking-audit.service';
import { RankingEventService } from './ranking-event.service';
import { RankingValidationService } from './ranking-validation.service';

export interface CreateRankingInput {
  code: string;
  name: string;
  description?: string;
  category: string;
  subcategory?: string;
  entityType?: string;
  timeWindow?: string;
  scoreFormula?: Record<string, any>;
  visibility?: string;
  maxEntries?: number;
  country?: string;
  region?: string;
  season?: string;
  actorId?: string;
}

@Injectable()
export class RankingService {
  private readonly logger = new Logger(RankingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validationService: RankingValidationService,
    private readonly auditService: RankingAuditService,
    private readonly eventService: RankingEventService,
  ) {}

  async createRanking(input: CreateRankingInput) {
    this.validationService.validateCategory(input.category);
    if (input.timeWindow) this.validationService.validateTimeWindow(input.timeWindow);

    const def = await this.prisma.rankingDefinition.create({
      data: {
        code: input.code,
        name: input.name,
        description: input.description,
        category: input.category,
        subcategory: input.subcategory,
        entityType: input.entityType ?? 'USER',
        timeWindow: input.timeWindow ?? 'DAILY',
        scoreFormula: input.scoreFormula,
        visibility: input.visibility ?? 'PUBLIC',
        maxEntries: input.maxEntries ?? 1000,
        country: input.country,
        region: input.region,
        season: input.season,
      },
    });

    await this.auditService.logAudit('RANKING_CREATED', def.id, input.actorId, { code: def.code });

    return def;
  }

  async updateRankingStatus(id: string, status: string, actorId?: string) {
    await this.validationService.validateRankingDefinitionExists(id);

    const updated = await this.prisma.rankingDefinition.update({
      where: { id },
      data: { status },
    });

    await this.auditService.logAudit('RANKING_UPDATED', id, actorId, { status });

    return updated;
  }

  async getRankingDefinitions(category?: string, status?: string) {
    return this.prisma.rankingDefinition.findMany({
      where: {
        ...(category ? { category } : {}),
        ...(status ? { status } : { status: 'ACTIVE' }),
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
  }

  async getRankingDefinition(idOrCode: string) {
    const byId = await this.prisma.rankingDefinition
      .findUnique({ where: { id: idOrCode } })
      .catch(() => null);
    return byId ?? this.prisma.rankingDefinition.findUnique({ where: { code: idOrCode } });
  }

  async getUserRankPosition(userId: string, rankingId: string, dateKey?: string) {
    const def = await this.validationService.validateRankingDefinitionExists(rankingId);
    const key = dateKey ?? this.buildCurrentDateKey(def.timeWindow);

    return this.prisma.rankingEntry.findUnique({
      where: { rankingId_entityId_dateKey: { rankingId, entityId: userId, dateKey: key } },
    });
  }

  async getEntityRankPosition(entityId: string, rankingId: string, dateKey?: string) {
    const def = await this.validationService.validateRankingDefinitionExists(rankingId);
    const key = dateKey ?? this.buildCurrentDateKey(def.timeWindow);

    return this.prisma.rankingEntry.findUnique({
      where: { rankingId_entityId_dateKey: { rankingId, entityId, dateKey: key } },
    });
  }

  private buildCurrentDateKey(timeWindow: string): string {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');

    switch (timeWindow) {
      case 'HOURLY':
        return `${y}${m}${d}${String(now.getUTCHours()).padStart(2, '0')}`;
      case 'DAILY':
        return `${y}${m}${d}`;
      case 'MONTHLY':
        return `${y}${m}`;
      case 'YEARLY':
        return `${y}`;
      default:
        return 'alltime';
    }
  }
}
