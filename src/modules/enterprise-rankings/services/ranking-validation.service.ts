import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RANKING_CATEGORIES, RANKING_TIME_WINDOWS } from '../constants/ranking.constants';

@Injectable()
export class RankingValidationService {
  constructor(private readonly prisma: PrismaService) {}

  async validateUserExists(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User ${userId} not found`);
  }

  async validateRankingDefinitionExists(rankingId: string) {
    const def = await this.prisma.rankingDefinition.findUnique({ where: { id: rankingId } });
    if (!def) throw new NotFoundException(`Ranking definition ${rankingId} not found`);
    if (def.status !== 'ACTIVE')
      throw new BadRequestException(`Ranking ${rankingId} is not active`);
    return def;
  }

  async validateRankingByCode(code: string) {
    const def = await this.prisma.rankingDefinition.findUnique({ where: { code } });
    if (!def) throw new NotFoundException(`Ranking with code '${code}' not found`);
    if (def.status !== 'ACTIVE')
      throw new BadRequestException(`Ranking '${code}' is not active`);
    return def;
  }

  validateCategory(category: string): void {
    if (!(RANKING_CATEGORIES as readonly string[]).includes(category)) {
      throw new BadRequestException(
        `Invalid ranking category '${category}'. Valid: ${RANKING_CATEGORIES.join(', ')}`,
      );
    }
  }

  validateTimeWindow(timeWindow: string): void {
    if (!(RANKING_TIME_WINDOWS as readonly string[]).includes(timeWindow)) {
      throw new BadRequestException(
        `Invalid time window '${timeWindow}'. Valid: ${RANKING_TIME_WINDOWS.join(', ')}`,
      );
    }
  }

  validateScore(score: number): void {
    if (typeof score !== 'number' || score < 0 || !Number.isFinite(score)) {
      throw new BadRequestException('Score must be a non-negative finite number');
    }
  }

  async validateSnapshotIntegrity(rankingId: string, dateKey: string): Promise<void> {
    const existing = await this.prisma.enterpriseRankingSnapshot.count({
      where: { rankingId, dateKey },
    });
    if (existing > 0) {
      throw new BadRequestException(
        `Snapshot for ranking ${rankingId} on ${dateKey} already exists`,
      );
    }
  }
}
