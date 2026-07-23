import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';

@Injectable()
export class ReferralValidationService {
  constructor(private readonly prisma: PrismaService) {}

  async assertCodeExists(code: string): Promise<void> {
    const record = await this.prisma.referralCode.findUnique({
      where: { code },
    });
    if (!record) throw new NotFoundException(`Referral code "${code}" not found.`);
  }

  async assertCodeActive(code: string): Promise<void> {
    const record = await this.prisma.referralCode.findUnique({
      where: { code },
    });
    if (!record) throw new NotFoundException(`Referral code "${code}" not found.`);
    if (record.status !== 'ACTIVE') {
      throw new BadRequestException(`Referral code "${code}" is not active.`);
    }
    if (record.expiresAt && record.expiresAt < new Date()) {
      throw new BadRequestException(`Referral code "${code}" has expired.`);
    }
    if (record.usesCount >= record.maxUses) {
      throw new BadRequestException(`Referral code "${code}" has reached its maximum uses.`);
    }
  }

  async assertCampaignExists(campaignId: string): Promise<void> {
    const campaign = await this.prisma.referralCampaign.findUnique({
      where: { id: campaignId },
    });
    if (!campaign) throw new NotFoundException(`Campaign "${campaignId}" not found.`);
  }

  async assertCampaignActive(campaignId: string): Promise<void> {
    const campaign = await this.prisma.referralCampaign.findUnique({
      where: { id: campaignId },
    });
    if (!campaign) throw new NotFoundException(`Campaign "${campaignId}" not found.`);
    if (campaign.status !== 'ACTIVE') {
      throw new BadRequestException(`Campaign "${campaignId}" is not active.`);
    }
    if (campaign.endTime && campaign.endTime < new Date()) {
      throw new BadRequestException(`Campaign "${campaignId}" has ended.`);
    }
    if (campaign.usesCount >= campaign.maxUses) {
      throw new BadRequestException(`Campaign "${campaignId}" has reached its capacity.`);
    }
  }

  async assertRelationshipExists(id: string): Promise<void> {
    const rel = await this.prisma.referralRelationship.findUnique({ where: { id } });
    if (!rel) throw new NotFoundException(`Referral relationship "${id}" not found.`);
  }

  assertNotEmptyString(value: string, fieldName: string): void {
    if (!value || value.trim().length === 0) {
      throw new BadRequestException(`"${fieldName}" must not be empty.`);
    }
  }

  assertValidCategory(category: string): void {
    const valid = [
      'USER', 'VIP', 'CREATOR', 'AGENCY', 'SELLER', 'CAMPAIGN',
      'EVENT', 'FAMILY', 'PROMOTIONAL', 'INVITE_LINK', 'QR_CODE', 'CUSTOM',
    ];
    if (!valid.includes(category)) {
      throw new BadRequestException(`Invalid referral category: "${category}".`);
    }
  }
}
