import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface HistoryQueryDto {
  page?: number;
  limit?: number;
}

@Injectable()
export class FamilyHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves paginated activity history for a family.
   */
  async getFamilyHistory(familyId: string, query: HistoryQueryDto = {}) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where = familyId ? { familyId } : {};

    const [total, items] = await Promise.all([
      this.prisma.familyHistory.count({ where }),
      this.prisma.familyHistory.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items,
    };
  }
}
