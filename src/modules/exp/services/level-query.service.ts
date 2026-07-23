import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class LevelQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async getTopUsers(limit: number = 50) {
    const top = await this.prisma.userLevel.findMany({
      orderBy: [{ currentLevel: 'desc' }, { lifetimeExp: 'desc' }],
      take: limit,
    });

    return top.map((u, idx) => ({
      rank: idx + 1,
      userId: u.userId,
      level: u.currentLevel,
      lifetimeExp: u.lifetimeExp.toString(),
    }));
  }

  async getLevelDistribution() {
    const levels = await this.prisma.userLevel.groupBy({
      by: ['currentLevel'],
      _count: { userId: true },
      orderBy: { currentLevel: 'asc' },
    });

    return levels.map((l) => ({
      level: l.currentLevel,
      userCount: l._count.userId,
    }));
  }
}
