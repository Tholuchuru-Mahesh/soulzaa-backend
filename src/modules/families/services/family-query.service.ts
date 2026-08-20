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
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (pageNum - 1) * limitNum;
    const where: any = {};
    if (query && query.trim()) {
      where.OR = [
        { name: { contains: query.trim(), mode: 'insensitive' as any } },
        { tag: { contains: query.trim(), mode: 'insensitive' as any } },
      ];
    }

    const [total, items] = await Promise.all([
      this.prisma.family.count({ where }),
      this.prisma.family.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: [{ level: 'desc' }, { exp: 'desc' }],
      }),
    ]);

    // Enrich with founder user names
    const founderIds = items.map((f) => f.founderId).filter(Boolean);
    const founders =
      founderIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: founderIds } },
            select: { id: true, username: true, fullName: true },
          })
        : [];
    const founderMap = new Map(
      founders.map((u) => [u.id, u.fullName || u.username || 'Founder']),
    );

    return {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
      items: items.map((f) => ({
        ...f,
        founderName: founderMap.get(f.founderId) || 'Founder',
        exp: (f.exp ?? 0).toString(),
        coins: (f.coins ?? 0).toString(),
        score: (f.score ?? 0).toString(),
        reputation: (f.reputation ?? 0).toString(),
      })),
    };
  }

  /**
   * Retrieves top family leaderboards by level and EXP.
   */
  async getTopFamilies(limit = 10) {
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const top = await this.prisma.family.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ level: 'desc' }, { exp: 'desc' }],
      take: limitNum,
    });

    const founderIds = top.map((f) => f.founderId).filter(Boolean);
    const founders =
      founderIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: founderIds } },
            select: { id: true, username: true, fullName: true },
          })
        : [];
    const founderMap = new Map(
      founders.map((u) => [u.id, u.fullName || u.username || 'Founder']),
    );

    return top.map((f) => ({
      ...f,
      founderName: founderMap.get(f.founderId) || 'Founder',
      exp: (f.exp ?? 0).toString(),
      coins: (f.coins ?? 0).toString(),
      score: (f.score ?? 0).toString(),
      reputation: (f.reputation ?? 0).toString(),
    }));
  }

  /**
   * Retrieves paginated member list of a family with user metadata.
   */
  async getFamilyMembers(familyId: string, page = 1, limit = 20) {
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (pageNum - 1) * limitNum;
    const where = { familyId };

    const [total, items] = await Promise.all([
      this.prisma.familyMember.count({ where }),
      this.prisma.familyMember.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { joinedAt: 'asc' },
      }),
    ]);

    const userIds = items.map((m) => m.userId);
    const users =
      userIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true, fullName: true },
          })
        : [];
    const userMap = new Map(
      users.map((u) => [u.id, { username: u.username, fullName: u.fullName }]),
    );

    return {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
      items: items.map((m) => {
        const u = userMap.get(m.userId);
        return {
          ...m,
          username: u?.fullName || u?.username || 'Member',
          rawUsername: u?.username || null,
          expContribution: (m.expContribution ?? 0).toString(),
          coinContribution: (m.coinContribution ?? 0).toString(),
        };
      }),
    };
  }
}
