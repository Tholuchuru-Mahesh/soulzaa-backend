import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import {
  ANALYTICS_AUDIT_ACTIONS,
  AnalyticsAuditAction,
} from '../constants/analytics-engine.constants';

export interface AuditEntry {
  action: AnalyticsAuditAction;
  reportId?: string;
  actorId?: string;
  details?: Record<string, unknown>;
}

@Injectable()
export class AnalyticsAuditService {
  private readonly logger = new Logger(AnalyticsAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    await this.prisma.analyticsAudit.create({
      data: {
        action: entry.action,
        reportId: entry.reportId ?? null,
        actorId: entry.actorId ?? null,
        details: (entry.details ?? {}) as any,
      },
    });
    this.logger.log(`Audit [${entry.action}] — report: ${entry.reportId ?? 'N/A'}`);
  }

  async queryByAction(action: AnalyticsAuditAction, limit = 100): Promise<unknown[]> {
    return this.prisma.analyticsAudit.findMany({
      where: { action },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async queryByReport(reportId: string): Promise<unknown[]> {
    return this.prisma.analyticsAudit.findMany({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAll(skip = 0, take = 100): Promise<unknown[]> {
    return this.prisma.analyticsAudit.findMany({
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
  }

  getSupportedActions(): string[] {
    return [...ANALYTICS_AUDIT_ACTIONS];
  }
}
