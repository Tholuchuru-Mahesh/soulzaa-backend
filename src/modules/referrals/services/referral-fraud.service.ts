import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { ReferralConfigurationService } from './referral-configuration.service';

export interface FraudCheckInput {
  referrerId: string;
  refereeId: string;
  referralCodeId?: string;
  campaignId?: string;
}

export interface FraudCheckResult {
  passed: boolean;
  reasons: string[];
}

@Injectable()
export class ReferralFraudService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ReferralConfigurationService,
  ) {}

  async runChecks(input: FraudCheckInput): Promise<FraudCheckResult> {
    const reasons: string[] = [];

    // 1. Self-referral detection
    const selfAllowed = await this.config.isSelfReferralAllowed();
    if (!selfAllowed && input.referrerId === input.refereeId) {
      reasons.push('Self-referral is not permitted.');
    }

    // 2. Duplicate referee detection — one referee can only be referred once globally
    const existing = await this.prisma.referralRelationship.findUnique({
      where: { refereeId: input.refereeId },
    });
    if (existing) {
      reasons.push('Referee has already been referred by another user.');
    }

    // 3. Campaign abuse — check referrer has not already exhausted campaign slots
    if (input.campaignId) {
      const campaignCount = await this.prisma.referralRelationship.count({
        where: {
          referrerId: input.referrerId,
          campaignId: input.campaignId,
          status: { notIn: ['REJECTED', 'CANCELLED'] },
        },
      });
      const maxUses = await this.config.getMaxUses();
      if (campaignCount >= maxUses) {
        reasons.push(
          `Referrer has exceeded the maximum referrals (${maxUses}) for this campaign.`,
        );
      }
    }

    // 4. Idempotent reward prevention — reject if relationship already rewarded
    if (existing && existing.status === 'REWARDED') {
      reasons.push('Referral reward has already been dispatched for this referee.');
    }

    return { passed: reasons.length === 0, reasons };
  }

  async assertNoDuplicateReward(relationshipId: string): Promise<void> {
    const existing = await this.prisma.referralReward.findFirst({
      where: { relationshipId, dispatched: true },
    });
    if (existing) {
      throw new BadRequestException(
        'Referral reward already dispatched — duplicate reward prevention triggered.',
      );
    }
  }
}
