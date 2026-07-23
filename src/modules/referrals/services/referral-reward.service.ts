import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { ReferralFraudService } from './referral-fraud.service';
import { ReferralAuditService } from './referral-audit.service';
import { ReferralEventService } from './referral-event.service';

export interface DispatchRewardInput {
  relationshipId: string;
  referrerId: string;
  refereeId: string;
  rewardDefinition: Record<string, unknown>;
}

@Injectable()
export class ReferralRewardService {
  private readonly logger = new Logger(ReferralRewardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fraud: ReferralFraudService,
    private readonly audit: ReferralAuditService,
    private readonly events: ReferralEventService,
  ) {}

  /**
   * Dispatches a referral reward via domain event.
   * Does NOT mutate Wallet, EXP, or Ranking tables directly.
   */
  async dispatch(input: DispatchRewardInput): Promise<void> {
    // Replay protection
    await this.fraud.assertNoDuplicateReward(input.relationshipId);

    // Create reward record
    const reward = await this.prisma.referralReward.create({
      data: {
        relationshipId: input.relationshipId,
        referrerId: input.referrerId,
        refereeId: input.refereeId,
        rewardDefinition: input.rewardDefinition as any,
        dispatched: false,
      },
    });

    // Mark as dispatched
    await this.prisma.referralReward.update({
      where: { id: reward.id },
      data: { dispatched: true, dispatchedAt: new Date() },
    });

    // Update relationship status
    await this.prisma.referralRelationship.update({
      where: { id: input.relationshipId },
      data: { status: 'REWARDED', rewardedAt: new Date() },
    });

    // Publish domain event — other modules consume this to execute actual rewards
    this.events.emitRewardDispatched({
      relationshipId: input.relationshipId,
      referrerId: input.referrerId,
      refereeId: input.refereeId,
      rewardDefinition: input.rewardDefinition,
    });

    await this.audit.log({
      action: 'REFERRAL_REWARD_DISPATCHED',
      relationshipId: input.relationshipId,
      details: { rewardDefinition: input.rewardDefinition },
    });

    this.logger.log(`Reward dispatched for relationship: ${input.relationshipId}`);
  }

  async getByRelationship(relationshipId: string): Promise<unknown[]> {
    return this.prisma.referralReward.findMany({
      where: { relationshipId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getByReferrer(referrerId: string): Promise<unknown[]> {
    return this.prisma.referralReward.findMany({
      where: { referrerId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
