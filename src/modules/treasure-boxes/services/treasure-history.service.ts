import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface HistoryQuery {
  page?: number;
  limit?: number;
}

@Injectable()
export class TreasureHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves past treasure sessions for a room.
   */
  async getRoomSessionHistory(roomId: string, query: HistoryQuery = {}) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const [total, items] = await Promise.all([
      this.prisma.treasureSession.count({ where: { roomId } }),
      this.prisma.treasureSession.findMany({
        where: { roomId },
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

  /**
   * Retrieves treasure reward distributions for a room.
   */
  async getRoomRewardHistory(roomId: string, query: HistoryQuery = {}) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const [total, items] = await Promise.all([
      this.prisma.treasureReward.count({ where: { roomId } }),
      this.prisma.treasureReward.findMany({
        where: { roomId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const formatted = items.map((i) => ({
      ...i,
      coins: i.coins ? i.coins.toString() : '0',
    }));

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items: formatted,
    };
  }
}
