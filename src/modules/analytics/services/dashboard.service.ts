import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { AnalyticsEventService } from './analytics-event.service';
import { AnalyticsAuditService } from './analytics-audit.service';

export interface CreateDashboardInput {
  name: string;
  description?: string;
  layout?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: AnalyticsEventService,
    private readonly audit: AnalyticsAuditService,
  ) {}

  async create(input: CreateDashboardInput): Promise<unknown> {
    const dashboard = await this.prisma.analyticsDashboard.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        layout: (input.layout ?? {}) as any,
        metrics: (input.metrics ?? {}) as any,
      },
    });
    this.logger.log(`Dashboard created: ${input.name}`);
    return dashboard;
  }

  async getDashboard(id: string): Promise<unknown> {
    return this.prisma.analyticsDashboard.findUnique({
      where: { id },
    });
  }

  async listDashboards(): Promise<unknown[]> {
    return this.prisma.analyticsDashboard.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateLayout(id: string, layout: Record<string, unknown>): Promise<void> {
    await this.prisma.analyticsDashboard.update({
      where: { id },
      data: { layout: layout as any },
    });
    this.events.emitDashboardRefreshed({ dashboardId: id });
    await this.audit.log({ action: 'DASHBOARD_REFRESHED', details: { id, layout } });
  }
}
