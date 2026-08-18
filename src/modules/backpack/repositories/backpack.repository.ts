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

  /** The user's currently-equipped item of a type (one-per-type), or null. */
  async findEquippedByType(userId: string, type: BackpackItemType): Promise<BackpackItem | null> {
    await this.ensureDefaultPinkFrame(userId);
    return this.prisma.backpackItem.findFirst({ where: { userId, type, equipped: true } });
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
    return count > 0;
  }

  create(
    data: Prisma.BackpackItemUncheckedCreateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<BackpackItem> {
    const client = tx || this.prisma;
    return client.backpackItem.create({ data });
  }

  async listItems(
    userId: string,
    skip: number,
    take: number,
    filter: { type?: BackpackItemType; equipped?: boolean },
  ): Promise<[BackpackItem[], number]> {
    await this.ensureDefaultPinkFrame(userId);
    const where: Prisma.BackpackItemWhereInput = {
      userId,
      ...(filter.type
        ? { type: filter.type }
        : {
            type: {
              notIn: [
                'FRAME',
                'THEME',
                'ENTRANCE_EFFECT',
              ] as BackpackItemType[],
            },
          }),
      ...(filter.equipped !== undefined ? { equipped: filter.equipped } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.backpackItem.findMany({ where, skip, take, orderBy: { acquiredAt: 'desc' } }),
      this.prisma.backpackItem.count({ where }),
    ]);
  }

  /** Set `equipped` on an item. */
  async setEquipped(id: string, equipped: boolean): Promise<void> {
    await this.prisma.backpackItem.update({ where: { id }, data: { equipped } });
  }

  /** Unequip every currently-equipped item of a type for a user (one-per-type). */
  async unequipType(userId: string, type: BackpackItemType): Promise<void> {
    await this.prisma.backpackItem.updateMany({
      where: { userId, type, equipped: true },
      data: { equipped: false },
    });
  }

  /** Reassign an item to another user (transfer); clears equipped state. */
  transfer(id: string, toUserId: string): Promise<BackpackItem> {
    return this.prisma.backpackItem.update({
      where: { id },
      data: { userId: toUserId, equipped: false },
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
