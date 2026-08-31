import { Injectable } from '@nestjs/common';
import { CosmeticType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';

export interface HistoryQuery {
  page?: number;
  limit?: number;
}

/** Backpack item types that map 1:1 onto a catalog cosmetic type. */
const COSMETIC_TYPE_NAMES = new Set<string>(Object.values(CosmeticType));

@Injectable()
export class TreasureHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaUrlResolver,
  ) {}

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
   * Retrieves treasure reward distributions for a room. Backpack-item rewards are
   * enriched with the granting cosmetic's resolved media/thumbnail so the app can
   * render the actual asset (frame/theme/entry-effect art) in the rewards log.
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

    const assetKeys = Array.from(
      new Set(
        items
          .filter((i) => i.itemType && i.itemName && COSMETIC_TYPE_NAMES.has(i.itemType))
          .map((i) => `${i.itemType}::${i.itemName}`),
      ),
    );

    const mediaByKey = new Map<string, { mediaUrl: string | null; thumbnailUrl: string | null }>();
    if (assetKeys.length > 0) {
      const cosmetics = await this.prisma.cosmetic.findMany({
        where: {
          OR: assetKeys.map((k) => {
            const [type, ...rest] = k.split('::');
            return { type: type as CosmeticType, name: rest.join('::') };
          }),
        },
        select: { type: true, name: true, mediaUrl: true, thumbnailUrl: true },
      });
      for (const c of cosmetics) {
        mediaByKey.set(`${c.type}::${c.name}`, {
          mediaUrl: await this.media.resolve(c.mediaUrl),
          thumbnailUrl: await this.media.resolve(c.thumbnailUrl ?? c.mediaUrl),
        });
      }
    }

    const formatted = items.map((i) => {
      const asset =
        i.itemType && i.itemName ? mediaByKey.get(`${i.itemType}::${i.itemName}`) : null;
      return {
        ...i,
        // Numeric (not a stringified BigInt) so the app parses it as `int?`.
        coins: i.coins != null ? Number(i.coins) : null,
        mediaUrl: asset?.mediaUrl ?? null,
        thumbnailUrl: asset?.thumbnailUrl ?? null,
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
}
