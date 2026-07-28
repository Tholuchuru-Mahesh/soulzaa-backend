import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { S3Service } from '../../../infra/storage/s3.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';

import { AnalyticsEventService } from './analytics-event.service';
import { AnalyticsAuditService } from './analytics-audit.service';
import { serializeReport, SUPPORTED_EXPORT_FORMATS } from './report-serializer';

export interface CreateExportInput {
  reportId: string;
  format: string;
  actorId?: string;
}

/** Download links live for a week; the object is re-signable from the stored key. */
const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly events: AnalyticsEventService,
    private readonly audit: AnalyticsAuditService,
  ) {}

  /**
   * Renders a report to a file, stores it, and returns a signed download link.
   *
   * The export is only marked COMPLETED once the object is actually in storage —
   * previously a fabricated URL was written and the row marked COMPLETED without
   * anything being rendered, so every download 404'd.
   */
  async exportReport(input: CreateExportInput): Promise<unknown> {
    const format = input.format.toUpperCase();
    if (!(SUPPORTED_EXPORT_FORMATS as readonly string[]).includes(format)) {
      throw new BadRequestException(
        `Export format '${input.format}' is not supported. Supported: ${SUPPORTED_EXPORT_FORMATS.join(', ')}`,
      );
    }

    const report = await this.prisma.analyticsReport.findUnique({
      where: { id: input.reportId },
    });
    if (!report) {
      throw new NotFoundException(`Report '${input.reportId}' not found`);
    }

    const exportRecord = await this.prisma.reportExport.create({
      data: {
        reportId: input.reportId,
        format,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
      },
    });

    try {
      const { body, contentType, extension } = serializeReport(
        {
          name: report.name,
          domain: report.domain,
          createdAt: report.createdAt,
          data: report.data,
        },
        format,
      );

      const key = `analytics-exports/${input.reportId}/${exportRecord.id}.${extension}`;
      await this.s3.putObject(key, body, contentType);
      const url = await this.s3.getPresignedDownloadUrl(key);

      const completed = await this.prisma.reportExport.update({
        where: { id: exportRecord.id },
        data: { status: 'COMPLETED', url },
      });

      this.events.emitReportExported({
        exportId: exportRecord.id,
        reportId: input.reportId,
        actorId: input.actorId,
        metadata: { format, key, bytes: body.byteLength },
      });

      await this.audit.log({
        action: 'REPORT_EXPORTED',
        reportId: input.reportId,
        actorId: input.actorId,
        details: { format, exportId: exportRecord.id, key, bytes: body.byteLength },
      });

      return completed;
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
