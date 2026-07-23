import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class RankingQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fetch historical position changes for an entity across rankings.
   */
  async getEntityRankingHistory(entityId: string, limit = 50, offset = 0) {
    const [items, total] = await Promise.all([
      this.prisma.rankingHistory.findMany({
        where: { entityId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.rankingHistory.count({ where: { entityId } }),
    ]);

    return { items, total, limit, offset };
  }

  /**
   * Fetch all ranking entries for an entity in active rankings.
   */
  async getEntityActiveRankings(entityId: string) {
    return this.prisma.rankingEntry.findMany({
      where: { entityId },
      include: { ranking: true },
      orderBy: { rank: 'asc' },
    });
  }

  /**
   * Fetch top rankings by category.
   */
  async getRankingsByCategory(category: string) {
    return this.prisma.rankingDefinition.findMany({
      where: { category, status: 'ACTIVE' },
      include: {
        entries: {
          orderBy: { rank: 'asc' },
          take: 10,
        },
      },
    });
  }
}
