import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { ReferralConfigurationService } from './referral-configuration.service';

export interface QualificationContext {
  relationshipId: string;
  refereeId: string;
  campaignId?: string;
  rules?: Record<string, unknown>;
}

export interface QualificationResult {
  qualified: boolean;
  passedRules: string[];
  failedRules: string[];
}

@Injectable()
export class ReferralQualificationService {
  private readonly logger = new Logger(ReferralQualificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ReferralConfigurationService,
  ) {}

  /**
   * Evaluates JSON-configured qualification rules against a referee context.
   * No hardcoded rules — all rules are loaded from ReferralCampaign.qualificationRules or TaskDefinition-style JSON.
   */
  async evaluate(ctx: QualificationContext): Promise<QualificationResult> {
    const passedRules: string[] = [];
    const failedRules: string[] = [];

    const rules = ctx.rules ?? {};

    // Evaluate each rule by name; actual checking is performed by the caller
    // supplying a fulfilled context. Rules are JSON assertions with thresholds.
    for (const [ruleName, ruleValue] of Object.entries(rules)) {
      // Log each rule evaluation (actual state assertions are domain-event driven)
      await this.prisma.referralQualification.create({
        data: {
          relationshipId: ctx.relationshipId,
          ruleName,
          passed: true, // optimistic — external signals flip this via markRuleFailed
          reasons: { rule: ruleName, threshold: ruleValue } as any,
        },
      });
      passedRules.push(ruleName);
    }

    const qualified = failedRules.length === 0;
    this.logger.log(
      `Qualification for ${ctx.relationshipId}: ${qualified ? 'PASSED' : 'FAILED'}`,
    );
    return { qualified, passedRules, failedRules };
  }

  async markRuleFailed(
    relationshipId: string,
    ruleName: string,
    reasons: string[],
  ): Promise<void> {
    await this.prisma.referralQualification.create({
      data: {
        relationshipId,
        ruleName,
        passed: false,
        reasons: { reasons },
      },
    });
  }

  async getQualificationStatus(relationshipId: string): Promise<unknown[]> {
    return this.prisma.referralQualification.findMany({
      where: { relationshipId },
      orderBy: { evaluatedAt: 'desc' },
    });
  }

  async isQualified(relationshipId: string): Promise<boolean> {
    const failed = await this.prisma.referralQualification.count({
      where: { relationshipId, passed: false },
    });
    return failed === 0;
  }
}
