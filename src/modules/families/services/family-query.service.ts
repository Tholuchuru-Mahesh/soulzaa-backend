import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class FamilyQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves global family summary metrics.
   */
  async getGlobalSummary() {
    const [totalFamilies, activeFamilies, totalMembers] = await Promise.all([
      this.prisma.family.count(),
      this.prisma.family.count({ where: { status: 'ACTIVE' } }),
      this.prisma.familyMember.count(),
    ]);

    return {
      totalFamilies,
      activeFamilies,
      totalMembers,
    };
  }

  /**
   * Search families by keyword or tag.
   */
  async searchFamilies(query: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = {
      status: 'ACTIVE',
      OR: [
        { name: { contains: query, mode: 'insensitive' as any } },
        { tag: { contains: query, mode: 'insensitive' as any } },
      ],
    };

    const [total, items] = await Promise.all([
      this.prisma.family.count({ where }),
      this.prisma.family.findMany({
        where,
        skip,
        take: limit,
        orderBy: { level: 'desc' },
      }),
    ]);

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items: items.map((f) => ({
        ...f,
        exp: f.exp.toString(),
        coins: f.coins.toString(),
        score: f.score.toString(),
        reputation: f.reputation.toString(),
      })),
    };
  }

  /**
   * Retrieves top family leaderboards by level and EXP.
   */
  async getTopFamilies(limit = 10) {
    const top = await this.prisma.family.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ level: 'desc' }, { exp: 'desc' }],
      take: Math.min(100, Math.max(1, limit)),
    });

    return top.map((f) => ({
      ...f,
      exp: f.exp.toString(),
      coins: f.coins.toString(),
      score: f.score.toString(),
      reputation: f.reputation.toString(),
    }));
  }

  /**
   * Retrieves paginated member list of a family.
   */
  async getFamilyMembers(familyId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = { familyId };

    const [total, items] = await Promise.all([
      this.prisma.familyMember.count({ where }),
      this.prisma.familyMember.findMany({
        where,
        skip,
        take: limit,
        orderBy: { joinedAt: 'asc' },
      }),
    ]);

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items: items.map((m) => ({
        ...m,
        expContribution: m.expContribution.toString(),
        coinContribution: m.coinContribution.toString(),
      })),
    };
  }
}
