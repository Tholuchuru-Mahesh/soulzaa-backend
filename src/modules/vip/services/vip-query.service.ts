import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { VipBenefitService } from './vip-benefit.service';

@Injectable()
export class VipQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly benefitService: VipBenefitService,
  ) {}

  /**
   * Get user's active VIP membership details and entitlements.
   */
  async getUserVipDetails(userId: string) {
    const membership = await this.prisma.vipMembership.findUnique({
      where: { userId },
    });

    const entitlements = await this.benefitService.getUserEntitlements(userId);

    if (!membership) {
      return {
        hasActiveMembership: false,
        membership: null,
        entitlements,
      };
    }

    return {
      hasActiveMembership: membership.status === 'ACTIVE' && membership.expiresAt > new Date(),
      membership: {
        ...membership,
        expGained: membership.expGained.toString(),
        totalSpent: membership.totalSpent.toString(),
      },
      entitlements,
    };
  }

  /**
   * Retrieves active subscriptions for a user.
   */
  async getUserSubscriptions(userId: string) {
    const subs = await this.prisma.vipSubscription.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return subs.map((s) => ({
      ...s,
      pricePaid: s.pricePaid.toString(),
    }));
  }
}
