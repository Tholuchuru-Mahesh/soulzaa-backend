import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import { GiftHistoryQueryDto } from '../dto/send-gift.dto';

@Injectable()
export class GiftHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaUrlResolver,
  ) {}

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

    const giftIds = [...new Set(transactions.map((r) => r.giftId))];
    const userIds = [
      ...new Set([
        ...transactions.map((r) => r.senderId),
        ...transactions.map((r) => r.receiverId),
      ]),
    ];

    const [gifts, users] = await Promise.all([
      giftIds.length > 0 ? this.prisma.gift.findMany({ where: { id: { in: giftIds } } }) : [],
      userIds.length > 0
        ? this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true, fullName: true },
          })
        : [],
    ]);

    const resolvedGifts = await Promise.all(
      gifts.map(async (g) => {
        const thumbKey =
          g.thumbnailUrl || (g as any).iconUrl || g.lottieUrl || g.animationUrl || null;
        const animKey =
          g.animationUrl || g.lottieUrl || g.svgaUrl || g.mp4Url || (g as any).mediaUrl || null;
        return {
          ...g,
          resolvedThumbnailUrl: thumbKey ? await this.media.resolve(thumbKey) : null,
          resolvedAnimationUrl: animKey ? await this.media.resolve(animKey) : null,
        };
      }),
    );

    const giftMap = new Map(resolvedGifts.map((g) => [g.id, g]));
    const userMap = new Map(users.map((u) => [u.id, u]));

    const formatted = transactions.map((t) => {
      const gift = giftMap.get(t.giftId);
      const sender = userMap.get(t.senderId);
      const receiver = userMap.get(t.receiverId);

      return {
        ...t,
        totalCoinValue: t.totalCoinValue.toString(),
        creatorEarnings: t.creatorEarnings.toString(),
        giftName: gift?.displayName || gift?.name || 'Gift',
        giftThumbnailUrl:
          gift?.resolvedThumbnailUrl || gift?.thumbnailUrl || (gift as any)?.iconUrl || null,
        giftAnimationUrl:
          gift?.resolvedAnimationUrl || gift?.animationUrl || (gift as any)?.mediaUrl || null,
        senderName: sender?.fullName || sender?.username || null,
        senderUsername: sender?.username || null,
        receiverName: receiver?.fullName || receiver?.username || null,
        receiverUsername: receiver?.username || null,
      };
    });

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

  /**
   * Get user received gifts showcase with counts per gift (e.g. Cap x4, Car x8)
   */
  async getUserReceivedGiftsShowcase(userId: string) {
    const aggregates = await this.prisma.giftTransaction.groupBy({
      by: ['giftId'],
      where: { receiverId: userId },
      _sum: { quantity: true, totalCoinValue: true },
      _count: { id: true },
    });

    if (aggregates.length === 0) {
      return [];
    }

    const giftIds = aggregates.map((a) => a.giftId);
    const gifts = await this.prisma.gift.findMany({
      where: { id: { in: giftIds } },
    });

    const resolvedGifts = await Promise.all(
      gifts.map(async (g) => {
        const thumbKey =
          g.thumbnailUrl || (g as any).iconUrl || g.lottieUrl || g.animationUrl || null;
        return {
          ...g,
          resolvedThumbnailUrl: thumbKey ? await this.media.resolve(thumbKey) : null,
        };
      }),
    );

    const giftMap = new Map(resolvedGifts.map((g) => [g.id, g]));

    const result = aggregates
      .map((agg) => {
        const gift = giftMap.get(agg.giftId);
        if (!gift) return null;
        const count = Number(agg._sum.quantity ?? 0);
        const totalCoinValue = Number(agg._sum.totalCoinValue ?? 0);
        if (count <= 0) return null;

        return {
          giftId: agg.giftId,
          name: gift.name,
          displayName: gift.displayName || gift.name,
          thumbnailUrl:
            gift.resolvedThumbnailUrl || gift.thumbnailUrl || (gift as any)?.iconUrl || null,
          coinValue: Number(gift.coinValue ?? 0),
          count,
          totalCoinValue,
          category: gift.category || 'POPULAR',
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    // Sort by count desc, then totalCoinValue desc
    result.sort((a, b) => b.count - a.count || b.totalCoinValue - a.totalCoinValue);
    return result;
  }
}



