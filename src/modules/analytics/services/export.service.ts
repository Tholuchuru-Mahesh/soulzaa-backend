import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { NotificationEventService } from '../../notification/services/notification-event.service';
import { AnalyticsEventService } from './analytics-event.service';
import { AnalyticsAuditService } from './analytics-audit.service';

export interface CreateExportInput {
  reportId: string;
  format: string;
  actorId?: string;
}

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: AnalyticsEventService,
    private readonly audit: AnalyticsAuditService,
  ) {}

  /**
   * Generates a file download entry for a report export request.
   */
  async exportReport(input: CreateExportInput): Promise<unknown> {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7-day link expiry

    const exportRecord = await this.prisma.reportExport.create({
      data: {
        reportId: input.reportId,
        format: input.format,
        status: 'PENDING',
        expiresAt,
      },
    });

    try {
      const mockUrl = `https://soulzaa.app/exports/download/${exportRecord.id}.${input.format.toLowerCase()}`;

      // Simulate compiler rendering time
      await this.prisma.reportExport.update({
        where: { id: exportRecord.id },
        data: { status: 'COMPLETED', url: mockUrl },
      });

      this.events.emitReportExported({
        exportId: exportRecord.id,
        reportId: input.reportId,
        actorId: input.actorId,
        metadata: { format: input.format },
      });

      await this.audit.log({
        action: 'REPORT_EXPORTED',
        reportId: input.reportId,
        actorId: input.actorId,
        details: { format: input.format, exportId: exportRecord.id },
      });

      return { ...exportRecord, status: 'COMPLETED', url: mockUrl };
    } catch (err) {
      await this.prisma.reportExport.update({
        where: { id: exportRecord.id },
        data: { status: 'FAILED' },
      });
      this.logger.error(`Export failed: ${(err as Error).message}`);
      throw err;
    }
  }

  async getExportStatus(id: string): Promise<unknown> {
    return this.prisma.reportExport.findUnique({
      where: { id },
    });
  }

  async getReportExports(reportId: string): Promise<unknown[]> {
    return this.prisma.reportExport.findMany({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
