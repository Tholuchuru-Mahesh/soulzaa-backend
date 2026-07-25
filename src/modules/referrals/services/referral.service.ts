import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { ReferralCodeService } from './referral-code.service';
import { ReferralCampaignService } from './referral-campaign.service';
import { ReferralFraudService } from './referral-fraud.service';
import { ReferralValidationService } from './referral-validation.service';
import { ReferralAuditService } from './referral-audit.service';
import { ReferralEventService } from './referral-event.service';
import { ReferralQualificationService } from './referral-qualification.service';
import { ReferralConfigurationService } from './referral-configuration.service';

export interface RegisterReferralInput {
  referralCode: string;
  refereeId: string;
}

export interface QualifyReferralInput {
  relationshipId: string;
  rules?: Record<string, unknown>;
}

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly codeService: ReferralCodeService,
    private readonly campaignService: ReferralCampaignService,
    private readonly fraudService: ReferralFraudService,
    private readonly validation: ReferralValidationService,
    private readonly audit: ReferralAuditService,
    private readonly events: ReferralEventService,
    private readonly qualification: ReferralQualificationService,
    private readonly config: ReferralConfigurationService,
  ) {}

  /**
   * Registers a referee using a referral code.
   * Creates the ReferralRelationship record in REGISTERED state.
   */
  async register(input: RegisterReferralInput): Promise<unknown> {
    // Validate code
    await this.validation.assertCodeExists(input.referralCode);
    await this.validation.assertCodeActive(input.referralCode);

    const code = (await this.codeService.findByCode(input.referralCode)) as any;

    // Fraud checks
    const fraudResult = await this.fraudService.runChecks({
      referrerId: code.referrerId,
      refereeId: input.refereeId,
      referralCodeId: code.id,
      campaignId: code.campaignId ?? undefined,
    });

    if (!fraudResult.passed) {
      throw new BadRequestException(`Referral rejected: ${fraudResult.reasons.join('; ')}`);
    }

    // Determine expiry
    const qualificationTimeoutDays = await this.config.getQualificationTimeoutDays();
    const expiresAt = new Date(Date.now() + qualificationTimeoutDays * 24 * 60 * 60 * 1000);

    // Campaign qualification rules
    let campaignRules: Record<string, unknown> = {};
    if (code.campaignId) {
      await this.validation.assertCampaignActive(code.campaignId);
      const campaign = (await this.campaignService.findById(code.campaignId)) as any;
      campaignRules = (campaign?.qualificationRules as Record<string, unknown>) ?? {};
    }

    // Create relationship
    const relationship = await this.prisma.referralRelationship.create({
      data: {
        referralCodeId: code.id,
        referrerId: code.referrerId,
        refereeId: input.refereeId,
        campaignId: code.campaignId ?? null,
        referralType: code.campaignId ? 'CAMPAIGN' : 'USER',
        status: 'REGISTERED',
        expiresAt,
      },
    });

    // Increment code & campaign usage
    await this.codeService.incrementUses(code.id);
    if (code.campaignId) {
      await this.campaignService.incrementUses(code.campaignId);
    }

    // Emit domain event
    this.events.emitReferralRegistered({
      relationshipId: relationship.id,
      referrerId: code.referrerId,
      refereeId: input.refereeId,
      campaignId: code.campaignId ?? undefined,
    });

    await this.audit.log({
      action: 'REFERRAL_REGISTERED',
      relationshipId: relationship.id,
      details: { refereeId: input.refereeId, code: input.referralCode },
    });

    // Auto-qualify if no rules defined
    if (Object.keys(campaignRules).length === 0) {
      await this.qualify({
        relationshipId: relationship.id,
        rules: {},
      });
    }

    this.logger.log(`Referral registered: ${relationship.id} — referee: ${input.refereeId}`);
    return relationship;
  }

  /**
   * Qualifies a referral relationship after referee meets qualification rules.
   */
  async qualify(input: QualifyReferralInput): Promise<void> {
    await this.validation.assertRelationshipExists(input.relationshipId);

    const relationship = await this.prisma.referralRelationship.findUnique({
      where: { id: input.relationshipId },
    });

    if (relationship?.status === 'QUALIFIED' || relationship?.status === 'REWARDED') {
      this.logger.warn(`Relationship ${input.relationshipId} already qualified.`);
      return;
    }

    const result = await this.qualification.evaluate({
      relationshipId: input.relationshipId,
      refereeId: relationship!.refereeId,
      campaignId: relationship!.campaignId ?? undefined,
      rules: input.rules,
    });

    if (result.qualified) {
      await this.prisma.referralRelationship.update({
        where: { id: input.relationshipId },
        data: { status: 'QUALIFIED', qualifiedAt: new Date() },
      });

      this.events.emitReferralQualified({
        relationshipId: input.relationshipId,
        referrerId: relationship!.referrerId,
        refereeId: relationship!.refereeId,
      });

      await this.audit.log({
        action: 'REFERRAL_QUALIFIED',
        relationshipId: input.relationshipId,
      });
    }
  }

  async cancel(relationshipId: string, actorId?: string): Promise<void> {
    await this.validation.assertRelationshipExists(relationshipId);
    await this.prisma.referralRelationship.update({
      where: { id: relationshipId },
      data: { status: 'CANCELLED' },
    });
    this.events.emitReferralCancelled({ relationshipId });
    await this.audit.log({ action: 'REFERRAL_CANCELLED', relationshipId, actorId });
  }

  async expireStale(): Promise<number> {
    const expired = await this.prisma.referralRelationship.findMany({
      where: {
        status: { in: ['REGISTERED', 'CREATED'] },
        expiresAt: { lt: new Date() },
      },
    });

    for (const rel of expired) {
      await this.prisma.referralRelationship.update({
        where: { id: rel.id },
        data: { status: 'EXPIRED' },
      });
      this.events.emitReferralExpired({ relationshipId: rel.id });
      await this.audit.log({ action: 'REFERRAL_EXPIRED', relationshipId: rel.id });
    }

    return expired.length;
  }

  async findById(id: string): Promise<unknown> {
    return this.prisma.referralRelationship.findUnique({ where: { id } });
  }

  async findByReferrer(referrerId: string): Promise<unknown[]> {
    return this.prisma.referralRelationship.findMany({
      where: { referrerId },
      orderBy: { registeredAt: 'desc' },
    });
  }

  async findByReferee(refereeId: string): Promise<unknown> {
    return this.prisma.referralRelationship.findUnique({ where: { refereeId } });
  }
}
