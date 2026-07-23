import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TreasuryAuditService } from './treasury-audit.service';

@Injectable()
export class FinancialPolicyService {
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
   * Validates whether an amount respects the configured policy cap
   */
  async validatePolicyLimit(key: string, amount: number): Promise<boolean> {
    try {
      const policy = await this.getPolicy(key);
      const cap = BigInt(policy.value);
      const requested = BigInt(amount);
      return requested <= cap;
    } catch {
      return true;
    }
  }
}
