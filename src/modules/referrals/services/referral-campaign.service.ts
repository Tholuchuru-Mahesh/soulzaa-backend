import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { ReferralValidationService } from './referral-validation.service';

export interface CreateCampaignInput {
  code: string;
  name: string;
  description?: string;
  category: string;
  qualificationRules?: Record<string, unknown>;
  rewardDefinition?: Record<string, unknown>;
  maxUses?: number;
  startTime?: Date;
  endTime?: Date;
}

@Injectable()
export class ReferralCampaignService {
  private readonly logger = new Logger(ReferralCampaignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validation: ReferralValidationService,
  ) {}

  async create(input: CreateCampaignInput): Promise<unknown> {
    this.validation.assertNotEmptyString(input.code, 'code');
    this.validation.assertNotEmptyString(input.name, 'name');
    this.validation.assertValidCategory(input.category);

    const campaign = await this.prisma.referralCampaign.create({
      data: {
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        category: input.category,
        qualificationRules: (input.qualificationRules ?? {}) as any,
        rewardDefinition: (input.rewardDefinition ?? {}) as any,
        maxUses: input.maxUses ?? 10000,
        startTime: input.startTime ?? null,
        endTime: input.endTime ?? null,
      },
    });
    this.logger.log(`Campaign created: ${input.code}`);
    return campaign;
  }

  async findAll(status?: string, skip = 0, take = 50): Promise<unknown[]> {
    return this.prisma.referralCampaign.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
  }

  async findById(id: string): Promise<unknown> {
    return this.prisma.referralCampaign.findUnique({ where: { id } });
  }

  async findByCode(code: string): Promise<unknown> {
    return this.prisma.referralCampaign.findUnique({ where: { code } });
  }

  async setStatus(id: string, status: string): Promise<void> {
    await this.prisma.referralCampaign.update({
      where: { id },
      data: { status },
    });
    this.logger.log(`Campaign ${id} → ${status}`);
  }

  async incrementUses(campaignId: string): Promise<void> {
    await this.prisma.referralCampaign.update({
      where: { id: campaignId },
      data: { usesCount: { increment: 1 } },
    });
  }

  async expireStale(): Promise<number> {
    const result = await this.prisma.referralCampaign.updateMany({
      where: { status: 'ACTIVE', endTime: { lt: new Date() } },
      data: { status: 'EXPIRED' },
    });
    return result.count;
  }
}
