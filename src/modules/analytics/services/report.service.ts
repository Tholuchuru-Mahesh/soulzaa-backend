import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { AggregationService } from './aggregation.service';
import { AnalyticsEventService } from './analytics-event.service';
import { AnalyticsAuditService } from './analytics-audit.service';

export interface GenerateReportInput {
  name: string;
  domain: string;
  parameters?: Record<string, unknown>;
  actorId?: string;
}

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aggregation: AggregationService,
    private readonly events: AnalyticsEventService,
    private readonly audit: AnalyticsAuditService,
  ) {}

  /**
   * Generates a new AnalyticsReport by aggregating the requested domain.
   */
  async generateReport(input: GenerateReportInput): Promise<unknown> {
    this.logger.log(`Generating report: ${input.name} [${input.domain}]`);

    // Compile metrics dynamically
    const metricsData = await this.aggregation.aggregateDomainMetrics(input.domain);

    const report = await this.prisma.analyticsReport.create({
      data: {
        name: input.name,
        domain: input.domain,
        parameters: (input.parameters ?? {}) as any,
        data: metricsData as any,
        generatedBy: input.actorId ?? null,
      },
    });

    this.events.emitReportGenerated({
      reportId: report.id,
      domain: input.domain,
      actorId: input.actorId,
    });

    await this.audit.log({
      action: 'REPORT_GENERATED',
      reportId: report.id,
      actorId: input.actorId,
      details: { domain: input.domain },
    });

    return report;
  }

  async getReport(id: string): Promise<unknown> {
    return this.prisma.analyticsReport.findUnique({
      where: { id },
    });
  }

  async listReports(domain?: string, skip = 0, take = 50): Promise<unknown[]> {
    return this.prisma.analyticsReport.findMany({
      where: domain ? { domain } : undefined,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
  }
}
