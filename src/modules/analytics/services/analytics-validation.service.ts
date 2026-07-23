import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { ANALYTICS_DOMAINS, EXPORT_FORMATS } from '../constants/analytics-engine.constants';

@Injectable()
export class AnalyticsValidationService {
  constructor(private readonly prisma: PrismaService) {}

  assertValidDomain(domain: string): void {
    if (!ANALYTICS_DOMAINS.includes(domain as any)) {
      throw new BadRequestException(`Invalid analytics domain: "${domain}".`);
    }
  }

  assertValidDateRange(startDateStr?: string, endDateStr?: string): void {
    if (!startDateStr || !endDateStr) {
      throw new BadRequestException('Start date and end date are required.');
    }
    const start = new Date(startDateStr);
    const end = new Date(endDateStr);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new BadRequestException('Invalid date format.');
    }

    if (start > end) {
      throw new BadRequestException('Start date must be before or equal to end date.');
    }
  }

  assertValidFormat(format: string): void {
    if (!EXPORT_FORMATS.includes(format as any)) {
      throw new BadRequestException(`Unsupported export format: "${format}".`);
    }
  }

  async assertDashboardExists(id: string): Promise<void> {
    const dashboard = await this.prisma.analyticsDashboard.findUnique({
      where: { id },
    });
    if (!dashboard) {
      throw new NotFoundException(`Dashboard with ID "${id}" not found.`);
    }
  }

  async assertReportExists(id: string): Promise<void> {
    const report = await this.prisma.analyticsReport.findUnique({
      where: { id },
    });
    if (!report) {
      throw new NotFoundException(`Report with ID "${id}" not found.`);
    }
  }
}
