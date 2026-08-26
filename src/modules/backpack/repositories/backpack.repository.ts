import { Injectable } from '@nestjs/common';
import { BackpackItem, BackpackItemType, Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Data layer for the backpack: the BackpackItem inventory + the append-only
 * BackpackLog history. Pure persistence — equip/transfer rules and locking live
 * in the service.
 */
@Injectable()
export class BackpackRepository {
  constructor(private readonly prisma: PrismaService) {}

  async ensureDefaultPinkFrame(userId: string): Promise<void> {
    const cosmeticId = '00000000-0000-0000-0000-000000000001';
    const grantKey = `default-pink-frame:${userId}`;

    // 1. Ensure the Cosmetic catalog entry exists
    await this.prisma.cosmetic.upsert({
      where: { id: cosmeticId },
      create: {
        id: cosmeticId,
        type: 'FRAME',
        name: 'Default Pink Frame',
        mediaUrl: 'default_pink_frame',
        thumbnailUrl: 'default_pink_frame',
        rarity: 'COMMON',
        enabled: true,
        price: 0,
        isPremium: false,
      },
      update: {},
    });

    // 2. Ensure this user owns the default pink frame in their backpack
    const exists = await this.prisma.backpackItem.count({
      where: { grantKey },
    });
    if (exists === 0) {
      const activeFrame = await this.prisma.backpackItem.findFirst({
        where: { userId, type: 'FRAME', equipped: true },
      });
      await this.prisma.backpackItem.create({
        data: {
          userId,
          type: 'FRAME',
          refId: cosmeticId,
          name: 'Default Pink Frame',
          source: 'ADMIN',
          quantity: 1,
          equipped: activeFrame ? false : true,
          transferable: false,
          grantKey,
          metadata: {
            cosmeticId,
            mediaUrl: 'default_pink_frame',
            rarity: 'COMMON',
          },
        },
      });
    }
  }

  async getItem(id: string): Promise<BackpackItem | null> {
    const item = await this.prisma.backpackItem.findUnique({ where: { id } });
    if (item) {
      await this.ensureDefaultPinkFrame(item.userId);
    }
    return item;
  }

  findByGrantKey(grantKey: string, tx?: Prisma.TransactionClient): Promise<BackpackItem | null> {
    const client = tx || this.prisma;
    return client.backpackItem.findUnique({ where: { grantKey } });
  }

  async findByUserIdAndRefId(
    userId: string,
    refId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<BackpackItem | null> {
    const client = tx || this.prisma;
    return client.backpackItem.findFirst({
      where: {
        userId,
        refId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { acquiredAt: 'desc' },
    });
  }

  updateItem(
    id: string,
    data: Prisma.BackpackItemUpdateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<BackpackItem> {
    const client = tx || this.prisma;
    return client.backpackItem.update({ where: { id }, data });
  }

  deleteItem(id: string, tx?: Prisma.TransactionClient): Promise<BackpackItem> {
    const client = tx || this.prisma;
    return client.backpackItem.delete({ where: { id } });
  }

  /** The user's currently-equipped item of a type (one-per-type), or null. */
  async findEquippedByType(userId: string, type: BackpackItemType): Promise<BackpackItem | null> {
    await this.ensureDefaultPinkFrame(userId);
    const bpItem = await this.prisma.backpackItem.findFirst({
      where: {
        userId,
        type,
        equipped: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (bpItem) return bpItem;

    const userCos = await this.prisma.userCosmetic.findFirst({
      where: {
        userId,
        equipped: true,
        cosmetic: { type: type as any },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: { cosmetic: true },
    });

    if (userCos && userCos.cosmetic) {
      return {
        id: userCos.id,
        userId: userCos.userId,
        type: userCos.cosmetic.type as any,
        refId: userCos.cosmeticId,
        name: userCos.cosmetic.name,
        source: 'PURCHASE' as any,
        quantity: 1,
        transferable: false,
        equipped: true,
        grantKey: `user-cosmetic:${userCos.id}`,
        metadata: {
          cosmeticId: userCos.cosmeticId,
          mediaUrl: userCos.cosmetic.mediaUrl,
          thumbnailUrl: userCos.cosmetic.thumbnailUrl,
        } as any,
        expiresAt: userCos.expiresAt,
        acquiredAt: userCos.acquiredAt,
      } as BackpackItem;
    }

    return null;
  }

  async findCosmeticById(id: string) {
    return this.prisma.cosmetic.findUnique({ where: { id } });
  }

  /** True when the user owns any (unexpired) item referencing this cosmetic id. */
  async ownsRef(userId: string, refId: string): Promise<boolean> {
    if (refId === '00000000-0000-0000-0000-000000000001') {
      await this.ensureDefaultPinkFrame(userId);
    }
    const count = await this.prisma.backpackItem.count({
      where: {
        userId,
        refId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (count > 0) return true;

    const userCosCount = await this.prisma.userCosmetic.count({
      where: {
        userId,
        cosmeticId: refId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    return userCosCount > 0;
  }

  create(
    data: Prisma.BackpackItemUncheckedCreateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<BackpackItem> {
    const client = tx || this.prisma;
    return client.backpackItem.create({ data });
  }

  async ensureUserCosmeticsSynced(userId: string): Promise<void> {
    const now = new Date();
    const userCosmetics = await this.prisma.userCosmetic.findMany({
      where: {
        userId,
        cosmetic: { enabled: true },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      include: { cosmetic: true },
    });

    for (const uc of userCosmetics) {
      if (!uc.cosmetic) continue;
      const grantKey = `user-cosmetic:${uc.id}`;
      const existing = await this.prisma.backpackItem.findFirst({
        where: {
          userId,
          OR: [{ grantKey }, { refId: uc.cosmeticId }],
        },
      });

      if (!existing) {
        await this.prisma.backpackItem.create({
          data: {
            userId,
            type: uc.cosmetic.type as BackpackItemType,
            refId: uc.cosmeticId,
            name: uc.cosmetic.name,
            source: 'PURCHASE',
            quantity: 1,
            equipped: uc.equipped,
            transferable: true,
            grantKey,
            expiresAt: uc.expiresAt,
            metadata: {
              cosmeticId: uc.cosmeticId,
              mediaUrl: uc.cosmetic.mediaUrl,
              thumbnailUrl: uc.cosmetic.thumbnailUrl,
              rarity: uc.cosmetic.rarity,
            },
          },
        });
      } else {
        await this.prisma.backpackItem.update({
          where: { id: existing.id },
          data: {
            name: uc.cosmetic.name,
            equipped: uc.equipped,
            expiresAt: uc.expiresAt,
            transferable: existing.source === 'GIFT' ? false : true,
            metadata: {
              cosmeticId: uc.cosmeticId,
              mediaUrl: uc.cosmetic.mediaUrl,
              thumbnailUrl: uc.cosmetic.thumbnailUrl,
              rarity: uc.cosmetic.rarity,
            },
          },
        });
      }
    }

    // Clean up expired items, items referencing deleted/disabled cosmetics,
    // and duplicates (same refId or same name+type when refId is absent).
    const allBackpackItems = await this.prisma.backpackItem.findMany({
      where: { userId },
      orderBy: { acquiredAt: 'asc' }, // oldest first — the latest will win dedup
    });

    // Build a set of ids to delete (duplicates by refId or name+type)
    const seenRefIds = new Map<string, string>(); // refId → item id (keep latest)
    const seenNameType = new Map<string, string>(); // `${name}:${type}` → item id (keep latest)
    const duplicateIds = new Set<string>();

    for (const item of allBackpackItems) {
      if (item.refId) {
        const prev = seenRefIds.get(item.refId);
        if (prev) duplicateIds.add(prev);
        seenRefIds.set(item.refId, item.id);
      } else {
        // Items without refId (TREASURE_BOX themes, ADMIN grants, etc.) — dedup by name+type
        const key = `${item.name.toLowerCase().trim()}:${item.type}`;
        const prev = seenNameType.get(key);
        if (prev) duplicateIds.add(prev);
        seenNameType.set(key, item.id);
      }
    }

    for (const item of allBackpackItems) {
      // 1. Delete expired
      if (item.expiresAt !== null && item.expiresAt <= now) {
        await this.prisma.backpackItem.delete({ where: { id: item.id } }).catch(() => null);
        continue;
      }
      // 2. Delete if cosmetic was deleted or disabled
      if (item.refId && item.refId !== '00000000-0000-0000-0000-000000000001') {
        const cosmetic = await this.prisma.cosmetic.findUnique({ where: { id: item.refId } });
        if (!cosmetic || !cosmetic.enabled) {
          await this.prisma.backpackItem.delete({ where: { id: item.id } }).catch(() => null);
          continue;
        }
      }
      // 3. Delete duplicates
      if (duplicateIds.has(item.id)) {
        await this.prisma.backpackItem.delete({ where: { id: item.id } }).catch(() => null);
        continue;
      }
      // 4. Fix transferable: non-GIFT-source items should be transferable
      if (item.source !== 'GIFT' && !item.transferable) {
        await this.prisma.backpackItem
          .update({
            where: { id: item.id },
            data: { transferable: true },
          })
          .catch(() => null);
      }
      // 5. Refresh metadata media URLs from cosmetic catalog if they contain
      //    hardcoded local/IP URLs (e.g. from old local MinIO dev purchases).
      //    Pattern: http(s)://192.x, http(s)://10.x, http(s)://localhost, http://127.
      if (item.refId && item.refId !== '00000000-0000-0000-0000-000000000001') {
        const meta = (item.metadata as Record<string, any>) || {};
        const mediaUrl: string = meta.mediaUrl ?? '';
        const isLocalUrl =
          /^https?:\/\/(192\.|10\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost)/i.test(mediaUrl);
        if (isLocalUrl) {
          const cosmetic = await this.prisma.cosmetic.findUnique({ where: { id: item.refId } });
          if (cosmetic) {
            await this.prisma.backpackItem
              .update({
                where: { id: item.id },
                data: {
                  name: cosmetic.name,
                  metadata: {
                    ...meta,
                    cosmeticId: cosmetic.id,
                    mediaUrl: cosmetic.mediaUrl,
                    thumbnailUrl: cosmetic.thumbnailUrl ?? cosmetic.mediaUrl,
                    rarity: cosmetic.rarity,
                  },
                },
              })
              .catch(() => null);
          }
        }
      }
    }
  }

  async listItems(
    userId: string,
    skip: number,
    take: number,
    filter: { type?: BackpackItemType; equipped?: boolean },
  ): Promise<[BackpackItem[], number]> {
    await this.ensureDefaultPinkFrame(userId);
    await this.ensureUserCosmeticsSynced(userId);
    const now = new Date();
    const where: Prisma.BackpackItemWhereInput = {
      userId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.equipped !== undefined ? { equipped: filter.equipped } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.backpackItem.findMany({ where, skip, take, orderBy: { acquiredAt: 'desc' } }),
      this.prisma.backpackItem.count({ where }),
    ]);
  }

  /** Set `equipped` on an item. */
  async setEquipped(id: string, equipped: boolean): Promise<void> {
    const item = await this.prisma.backpackItem.update({ where: { id }, data: { equipped } });
    if (
      item.refId &&
      (item.type === 'FRAME' || item.type === 'THEME' || item.type === 'ENTRANCE_EFFECT')
    ) {
      await this.prisma.userCosmetic.updateMany({
        where: { userId: item.userId, cosmeticId: item.refId },
        data: { equipped },
      });
    }
  }

  /** Unequip every currently-equipped item of a type for a user (one-per-type). */
  async unequipType(userId: string, type: BackpackItemType): Promise<void> {
    await this.prisma.backpackItem.updateMany({
      where: { userId, type, equipped: true },
      data: { equipped: false },
    });
    if (type === 'FRAME' || type === 'THEME' || type === 'ENTRANCE_EFFECT') {
      const sameTypeCosmetics = await this.prisma.cosmetic.findMany({
        where: { type: type as any },
        select: { id: true },
      });
      if (sameTypeCosmetics.length > 0) {
        await this.prisma.userCosmetic.updateMany({
          where: { userId, cosmeticId: { in: sameTypeCosmetics.map((c) => c.id) } },
          data: { equipped: false },
        });
      }
    }
  }

  /** Sync user_cosmetics table on transfer: remove from sender, grant/merge to recipient. */
  async syncUserCosmeticsOnTransfer(input: {
    fromUserId: string;
    toUserId: string;
    cosmeticId: string;
    expiresAt: Date | null;
    wasEquipped?: boolean;
  }): Promise<void> {
    // 1. Remove from sender's user_cosmetics table
    await this.prisma.userCosmetic
      .deleteMany({
        where: { userId: input.fromUserId, cosmeticId: input.cosmeticId },
      })
      .catch(() => null);

    // 2. Grant or update recipient's user_cosmetics table
    const existingRecipientCosmetic = await this.prisma.userCosmetic.findUnique({
      where: {
        userId_cosmeticId: {
          userId: input.toUserId,
          cosmeticId: input.cosmeticId,
        },
      },
    });

    if (existingRecipientCosmetic) {
      await this.prisma.userCosmetic
        .update({
          where: { id: existingRecipientCosmetic.id },
          data: { expiresAt: input.expiresAt },
        })
        .catch(() => null);
    } else {
      await this.prisma.userCosmetic
        .create({
          data: {
            userId: input.toUserId,
            cosmeticId: input.cosmeticId,
            expiresAt: input.expiresAt,
            equipped: false,
          },
        })
        .catch(() => null);
    }
  }

  /** Reassign an item to another user (transfer); clears equipped state, marks non-transferable and source GIFT. */
  transfer(id: string, toUserId: string): Promise<BackpackItem> {
    return this.prisma.backpackItem.update({
      where: { id },
      data: { userId: toUserId, equipped: false, transferable: false, source: 'GIFT' },
    });
  }

  async log(
    userId: string,
    action: string,
    itemId: string | null,
    metadata?: Prisma.InputJsonValue,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx || this.prisma;
    await client.backpackLog.create({
      data: { userId, action, itemId, ...(metadata !== undefined ? { metadata } : {}) },
    });
  }

  listLogs(userId: string, skip: number, take: number): Promise<[unknown[], number]> {
    const where: Prisma.BackpackLogWhereInput = { userId };
    return this.prisma.$transaction([
      this.prisma.backpackLog.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.backpackLog.count({ where }),
    ]);
  }
}
