import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TreasuryAuditService } from './treasury-audit.service';

@Injectable()
export class FinancialPolicyService {
  private readonly logger = new Logger(FinancialPolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: TreasuryAuditService,
  ) {}

  /**
   * List all platform financial policies
   */
  async listPolicies() {
    const policies = await this.prisma.financialPolicy.findMany({
      orderBy: { category: 'asc' },
    });

    return policies.map((p) => ({
      ...p,
      value: p.value.toString(),
      minLimit: p.minLimit != null ? p.minLimit.toString() : null,
      maxLimit: p.maxLimit != null ? p.maxLimit.toString() : null,
    }));
  }

  /**
   * Get single policy by key
   */
  async getPolicy(key: string) {
    const policy = await this.prisma.financialPolicy.findUnique({
      where: { key },
    });

    if (!policy) {
      throw new NotFoundException(`Financial policy '${key}' not found`);
    }

    return {
      ...policy,
      value: policy.value.toString(),
      minLimit: policy.minLimit != null ? policy.minLimit.toString() : null,
      maxLimit: policy.maxLimit != null ? policy.maxLimit.toString() : null,
    };
  }

  /**
   * Update financial policy value
   */
  async updatePolicy(key: string, newValue: number, reason?: string, actorId?: string) {
    const policy = await this.prisma.financialPolicy.findUnique({
      where: { key },
    });

    if (!policy) {
      throw new NotFoundException(`Financial policy '${key}' not found`);
    }

    if (!policy.isEditable) {
      throw new BadRequestException(`Financial policy '${key}' is immutable and cannot be updated`);
    }

    const valBig = BigInt(newValue);
    if (policy.minLimit != null && valBig < policy.minLimit) {
      throw new BadRequestException(
        `Policy value cannot be less than minimum limit (${policy.minLimit.toString()})`,
      );
    }
    if (policy.maxLimit != null && valBig > policy.maxLimit) {
      throw new BadRequestException(
        `Policy value cannot exceed maximum limit (${policy.maxLimit.toString()})`,
      );
    }

    const oldValueStr = policy.value.toString();
    const newValueStr = valBig.toString();

    const updated = await this.prisma.financialPolicy.update({
      where: { key },
      data: {
        value: valBig,
        updatedBy: actorId,
      },
    });

    await this.auditService.logOperation(
      'POLICY_CHANGE',
      valBig,
      oldValueStr,
      newValueStr,
      reason,
      actorId,
    );

    return {
      ...updated,
      value: updated.value.toString(),
      minLimit: updated.minLimit != null ? updated.minLimit.toString() : null,
      maxLimit: updated.maxLimit != null ? updated.maxLimit.toString() : null,
    };
  }

  /**
   * Validates whether an amount respects the configured policy cap.
   *
   * FAIL-CLOSED: a policy lookup/parse error (DB down, row missing, corrupt
   * value) returns `false`, so a payout in flight can NEVER exceed its cap on
   * a transient failure — the operation is refused and surfaced for manual
   * review instead of silently bypassing the cap. Keys are always seeded by
   * `TreasurySeederService.DEFAULT_FINANCIAL_POLICIES`, so a missing row is a
   * real anomaly that deserves a hard stop, not a quiet allowance.
   */
  async validatePolicyLimit(key: string, amount: number): Promise<boolean> {
    try {
      const policy = await this.getPolicy(key);
      const cap = BigInt(policy.value);
      const requested = BigInt(amount);
      return requested <= cap;
    } catch (err) {
      this.logger.error(
        `validatePolicyLimit("${key}", ${amount}) failed — refusing (fail closed): ` +
          `${(err as Error).message}`,
      );
      return false;
    }
  }
}
