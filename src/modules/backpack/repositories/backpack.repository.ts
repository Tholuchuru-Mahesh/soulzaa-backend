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

  getItem(id: string): Promise<BackpackItem | null> {
    return this.prisma.backpackItem.findUnique({ where: { id } });
  }

  findByGrantKey(grantKey: string, tx?: Prisma.TransactionClient): Promise<BackpackItem | null> {
    const client = tx || this.prisma;
    return client.backpackItem.findUnique({ where: { grantKey } });
  }

  /** The user's currently-equipped item of a type (one-per-type), or null. */
  findEquippedByType(userId: string, type: BackpackItemType): Promise<BackpackItem | null> {
    return this.prisma.backpackItem.findFirst({ where: { userId, type, equipped: true } });
  }

  /** True when the user owns any (unexpired) item referencing this cosmetic id. */
  async ownsRef(userId: string, refId: string): Promise<boolean> {
    const count = await this.prisma.backpackItem.count({
      where: {
        userId,
        refId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    return count > 0;
  }

  create(data: Prisma.BackpackItemUncheckedCreateInput, tx?: Prisma.TransactionClient): Promise<BackpackItem> {
    const client = tx || this.prisma;
    return client.backpackItem.create({ data });
  }

  listItems(
    userId: string,
    skip: number,
    take: number,
    filter: { type?: BackpackItemType; equipped?: boolean },
  ): Promise<[BackpackItem[], number]> {
    const where: Prisma.BackpackItemWhereInput = {
      userId,
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
