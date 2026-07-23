import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class GiftInventoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get user's backpack inventory
   */
  async getUserInventory(userId: string) {
    return this.prisma.giftInventory.findMany({
      where: { userId, quantity: { gt: 0 } },
      include: { gift: true },
    });
  }

  /**
   * Add gift quantity to user inventory
   */
  async addGiftToInventory(userId: string, giftId: string, quantity: number) {
    return this.prisma.giftInventory.upsert({
      where: { userId_giftId: { userId, giftId } },
      update: { quantity: { increment: quantity } },
      create: { userId, giftId, quantity },
    });
  }

  /**
   * Consume gift quantity from user inventory
   */
  async consumeInventoryGift(userId: string, giftId: string, quantity: number) {
    const inv = await this.prisma.giftInventory.findUnique({
      where: { userId_giftId: { userId, giftId } },
    });

    if (!inv || inv.quantity < quantity) {
      throw new BadRequestException(`Insufficient inventory for gift '${giftId}'`);
    }

    return this.prisma.giftInventory.update({
      where: { id: inv.id },
      data: { quantity: { decrement: quantity } },
    });
  }
}
