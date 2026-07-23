import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import {
  REFERRAL_AUDIT_ACTIONS,
  ReferralAuditAction,
} from '../constants/referral.constants';

export interface AuditEntry {
  action: ReferralAuditAction;
  relationshipId?: string;
  actorId?: string;
  details?: Record<string, unknown>;
}

@Injectable()
export class ReferralAuditService {
  private readonly logger = new Logger(ReferralAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    await this.prisma.referralAudit.create({
      data: {
        action: entry.action,
        relationshipId: entry.relationshipId ?? null,
        actorId: entry.actorId ?? null,
        details: (entry.details ?? {}) as any,
      },
    });
    this.logger.log(`Audit [${entry.action}] — relationship: ${entry.relationshipId ?? 'N/A'}`);
  }

  async queryByAction(
    action: ReferralAuditAction,
    limit = 100,
  ): Promise<unknown[]> {
    return this.prisma.referralAudit.findMany({
      where: { action },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async queryByRelationship(relationshipId: string): Promise<unknown[]> {
    return this.prisma.referralAudit.findMany({
      where: { relationshipId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAll(skip = 0, take = 100): Promise<unknown[]> {
    return this.prisma.referralAudit.findMany({
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
  }

  getSupportedActions(): string[] {
    return [...REFERRAL_AUDIT_ACTIONS];
  }
}
