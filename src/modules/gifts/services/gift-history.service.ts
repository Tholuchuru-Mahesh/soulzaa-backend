import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { GiftHistoryQueryDto } from '../dto/send-gift.dto';

@Injectable()
export class GiftHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get user gift transaction history (sent or received)
   */
  async getUserGiftHistory(userId: string, dto: GiftHistoryQueryDto) {
    const { contextType, contextId, page = 1, limit = 20 } = dto;
    const skip = (page - 1) * limit;

    const where: any = {
      OR: [{ senderId: userId }, { receiverId: userId }],
    };

    if (contextType) where.contextType = contextType.toUpperCase();
    if (contextId) where.contextId = contextId;

    const [total, transactions] = await Promise.all([
      this.prisma.giftTransaction.count({ where }),
      this.prisma.giftTransaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const formatted = transactions.map((t) => ({
      ...t,
      totalCoinValue: t.totalCoinValue.toString(),
      creatorEarnings: t.creatorEarnings.toString(),
    }));

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items: formatted,
    };
  }

  /**
   * Get gift transactions for a specific room or context ID
   */
  async getRoomGiftHistory(contextId: string, dto: GiftHistoryQueryDto) {
    const { page = 1, limit = 20 } = dto;
    const skip = (page - 1) * limit;

    const where = { contextId };

    const [total, transactions] = await Promise.all([
      this.prisma.giftTransaction.count({ where }),
      this.prisma.giftTransaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const formatted = transactions.map((t) => ({
      ...t,
      totalCoinValue: t.totalCoinValue.toString(),
      creatorEarnings: t.creatorEarnings.toString(),
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
