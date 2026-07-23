import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class GiftQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Search catalog gifts by keyword or tag
   */
  async searchGifts(query: string) {
    return this.prisma.gift.findMany({
      where: {
        enabled: true,
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { displayName: { contains: query, mode: 'insensitive' } },
          { tags: { has: query } },
        ],
      },
      orderBy: { popularity: 'desc' },
    });
  }

  /**
   * Get top popular gifts
   */
  async getPopularGifts(limit = 10) {
    return this.prisma.gift.findMany({
      where: { enabled: true },
      take: limit,
      orderBy: [{ popularity: 'desc' }, { priority: 'desc' }],
    });
  }
}
