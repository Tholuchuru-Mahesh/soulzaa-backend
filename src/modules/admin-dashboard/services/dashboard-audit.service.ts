import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { DASHBOARD_AUDIT_ACTIONS, DashboardAuditAction } from '../constants/dashboard.constants';

export interface AuditEntry {
  action: DashboardAuditAction;
  userId?: string;
  details?: Record<string, unknown>;
}

@Injectable()
export class DashboardAuditService {
  private readonly logger = new Logger(DashboardAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    await this.prisma.dashboardAudit.create({
      data: {
        action: entry.action,
        userId: entry.userId ?? null,
        details: (entry.details ?? {}) as any,
      },
    });
    this.logger.log(`Audit [${entry.action}] — user: ${entry.userId ?? 'System'}`);
  }

  async queryByAction(action: DashboardAuditAction, limit = 100): Promise<unknown[]> {
    return this.prisma.dashboardAudit.findMany({
      where: { action },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async findAll(skip = 0, take = 100): Promise<unknown[]> {
    return this.prisma.dashboardAudit.findMany({
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
  }

  getSupportedActions(): string[] {
    return [...DASHBOARD_AUDIT_ACTIONS];
  }
}
