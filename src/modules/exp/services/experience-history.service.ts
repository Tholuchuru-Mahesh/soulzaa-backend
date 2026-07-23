import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class ExperienceHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async getUserHistory(userId: string, limit: number = 20, offset: number = 0) {
    const [items, total] = await Promise.all([
      this.prisma.experienceHistory.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.experienceHistory.count({ where: { userId } }),
    ]);

    return {
      items: items.map((i) => ({
        ...i,
        totalExpAfter: i.totalExpAfter.toString(),
      })),
      total,
      limit,
      offset,
    };
  }
}
