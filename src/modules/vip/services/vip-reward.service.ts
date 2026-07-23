import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { VipAuditService } from './vip-audit.service';
import { VipValidationService } from './vip-validation.service';

@Injectable()
export class VipRewardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validationService: VipValidationService,
    private readonly auditService: VipAuditService,
  ) {}

  /**
   * Claims daily, weekly, or monthly VIP rewards for an active member.
   */
  async claimReward(userId: string, rewardType: 'DAILY' | 'WEEKLY' | 'MONTHLY') {
    const membership = await this.validationService.validateActiveMembership(userId);
    const tier = await this.prisma.vipTier.findUnique({
      where: { id: membership.tierId },
    });

    if (!tier) {
      throw new BadRequestException('Associated VIP tier not found');
    }

    const now = new Date();

    if (rewardType === 'DAILY') {
      if (membership.lastClaimedDailyAt) {
        const last = new Date(membership.lastClaimedDailyAt);
        if (last.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) {
          throw new BadRequestException('Daily VIP reward already claimed today');
        }
      }
    }

    const rewardsData = tier.dailyRewards;

    await this.prisma.$transaction([
      this.prisma.vipReward.create({
        data: {
          membershipId: membership.id,
          userId,
          rewardType,
          rewardData: rewardsData as any,
        },
      }),
      this.prisma.vipMembership.update({
        where: { id: membership.id },
        data: {
          lastClaimedDailyAt: rewardType === 'DAILY' ? now : undefined,
          lastClaimedWeeklyAt: rewardType === 'WEEKLY' ? now : undefined,
          lastClaimedMonthlyAt: rewardType === 'MONTHLY' ? now : undefined,
        },
      }),
    ]);

    await this.auditService.logAudit('VIP_CREATED', userId, { rewardType, rewardsData });

    return {
      claimed: true,
      rewardType,
      rewards: rewardsData,
    };
  }
}
