import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { DashboardValidationService } from './dashboard-validation.service';
import { DashboardEventService } from './dashboard-event.service';
import { DashboardAuditService } from './dashboard-audit.service';
import { DashboardStatisticsService } from './dashboard-statistics.service';

export interface CreateLayoutInput {
  userId: string;
  name: string;
  isDefault?: boolean;
  gridConfig: Record<string, unknown>;
}

@Injectable()
export class AdminDashboardService {
  private readonly logger = new Logger(AdminDashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validation: DashboardValidationService,
    private readonly events: DashboardEventService,
    private readonly audit: DashboardAuditService,
    private readonly statistics: DashboardStatisticsService,
  ) {}

  async createLayout(input: CreateLayoutInput): Promise<unknown> {
    this.validation.assertLayoutIntegrity(input.gridConfig);

    // If default, unset previous default layouts
    if (input.isDefault) {
      await this.prisma.dashboardLayout.updateMany({
        where: { userId: input.userId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const layout = await this.prisma.dashboardLayout.create({
      data: {
        userId: input.userId,
        name: input.name,
        isDefault: input.isDefault ?? false,
        gridConfig: input.gridConfig as any,
      },
    });

    this.events.emitLayoutUpdated({ userId: input.userId, layoutId: layout.id });
    
    await this.audit.log({
      action: 'DASHBOARD_LAYOUT_UPDATED',
      userId: input.userId,
      details: { layoutId: layout.id, name: input.name },
    });

    return layout;
  }

  async getLayout(id: string): Promise<unknown> {
    return this.prisma.dashboardLayout.findUnique({
      where: { id },
    });
  }

  async getUserLayouts(userId: string): Promise<unknown[]> {
    return this.prisma.dashboardLayout.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async markDashboardViewed(userId: string): Promise<void> {
    await this.audit.log({
      action: 'DASHBOARD_VIEWED',
      userId,
    });
    await this.statistics.incrementStat('widgetRefreshes');
  }
}
