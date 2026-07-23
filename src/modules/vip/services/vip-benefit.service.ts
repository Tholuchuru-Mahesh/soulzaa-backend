import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface VipEntitlements {
  isVip: boolean;
  level: number;
  badge?: string | null;
  frame?: string | null;
  entranceEffect?: string | null;
  chatBubble?: string | null;
  nameColor?: string | null;
  giftDiscount: number;
  storeDiscount: number;
  maxRooms: number;
  priorityMatching: boolean;
}

@Injectable()
export class VipBenefitService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves active VIP entitlements for a user.
   */
  async getUserEntitlements(userId: string): Promise<VipEntitlements> {
    const membership = await this.prisma.vipMembership.findUnique({
      where: { userId },
    });

    if (!membership || membership.status !== 'ACTIVE' || membership.expiresAt < new Date()) {
      return {
        isVip: false,
        level: 0,
        giftDiscount: 0,
        storeDiscount: 0,
        maxRooms: 1,
        priorityMatching: false,
      };
    }

    const tier = await this.prisma.vipTier.findUnique({
      where: { id: membership.tierId },
    });

    if (!tier) {
      return {
        isVip: true,
        level: membership.level,
        giftDiscount: 0,
        storeDiscount: 0,
        maxRooms: 1,
        priorityMatching: false,
      };
    }

    return {
      isVip: true,
      level: tier.level,
      badge: tier.badge,
      frame: tier.frame,
      entranceEffect: tier.entranceEffect,
      chatBubble: tier.chatBubble,
      nameColor: tier.nameColor,
      giftDiscount: tier.giftDiscount,
      storeDiscount: tier.storeDiscount,
      maxRooms: tier.maxRooms,
      priorityMatching: tier.priorityMatching,
    };
  }
}
