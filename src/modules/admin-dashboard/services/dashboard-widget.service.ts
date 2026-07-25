import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { DashboardValidationService } from './dashboard-validation.service';
import { DashboardEventService } from './dashboard-event.service';
import { DashboardAuditService } from './dashboard-audit.service';

export interface CreateWidgetInput {
  name: string;
  type: string;
  metricKey: string;
  visibleToRoles?: string[];
  config?: Record<string, unknown>;
}

@Injectable()
export class DashboardWidgetService {
  private readonly logger = new Logger(DashboardWidgetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validation: DashboardValidationService,
    private readonly events: DashboardEventService,
    private readonly audit: DashboardAuditService,
  ) {}

  async createWidget(input: CreateWidgetInput): Promise<unknown> {
    const widget = await this.prisma.dashboardWidget.create({
      data: {
        name: input.name,
        type: input.type,
        metricKey: input.metricKey,
        visibleToRoles: (input.visibleToRoles ?? []) as any,
        config: (input.config ?? {}) as any,
      },
    });
    this.logger.log(`Widget created: ${input.name}`);
    return widget;
  }

  async getWidget(id: string, userRole: string): Promise<unknown> {
    const widget = await this.prisma.dashboardWidget.findUnique({
      where: { id },
    });
    if (widget) {
      this.validation.assertRoleCanViewWidget(
        userRole,
        widget.visibleToRoles as string[] | undefined,
      );
    }
    return widget;
  }

  async listWidgets(userRole: string): Promise<unknown[]> {
    const widgets = await this.prisma.dashboardWidget.findMany({
      orderBy: { name: 'asc' },
    });
    // Filter widgets by userRole visibility
    return widgets.filter((w) => {
      try {
        this.validation.assertRoleCanViewWidget(userRole, w.visibleToRoles as string[] | undefined);
        return true;
      } catch {
        return false;
      }
    });
  }

  async updateWidgetConfig(
    id: string,
    config: Record<string, unknown>,
    userId?: string,
  ): Promise<void> {
    await this.validation.assertWidgetExists(id);

    await this.prisma.dashboardWidget.update({
      where: { id },
      data: { config: config as any },
    });

    this.events.emitWidgetUpdated({ widgetId: id });

    await this.audit.log({
      action: 'DASHBOARD_WIDGET_UPDATED',
      userId,
      details: { id, config },
    });
  }
}
