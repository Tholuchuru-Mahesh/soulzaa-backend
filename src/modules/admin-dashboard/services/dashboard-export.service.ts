import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { DashboardEventService } from './dashboard-event.service';
import { DashboardAuditService } from './dashboard-audit.service';
import { DashboardStatisticsService } from './dashboard-statistics.service';

export interface CreateDashboardExportInput {
  layoutId: string;
  format: string;
  userId?: string;
}

@Injectable()
export class DashboardExportService {
  private readonly logger = new Logger(DashboardExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DashboardEventService,
    private readonly audit: DashboardAuditService,
    private readonly statistics: DashboardStatisticsService,
  ) {}

  /**
   * Simulates/compiles dashboard exports into file downloads.
   */
  async exportDashboard(input: CreateDashboardExportInput): Promise<unknown> {
    const mockExportId = `export_${Date.now()}`;
    const mockUrl = `https://soulzaa.app/exports/download/${mockExportId}.${input.format.toLowerCase()}`;

    this.events.emitExportGenerated({
      exportId: mockExportId,
      userId: input.userId,
      metadata: { format: input.format, layoutId: input.layoutId },
    });

    await this.audit.log({
      action: 'DASHBOARD_EXPORT_GENERATED',
      userId: input.userId,
      details: { format: input.format, layoutId: input.layoutId, mockUrl },
    });

    await this.statistics.incrementStat('exportsCount');

    return {
      exportId: mockExportId,
      url: mockUrl,
      format: input.format,
      generatedAt: new Date(),
    };
  }
}
