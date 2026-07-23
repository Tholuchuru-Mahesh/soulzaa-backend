import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';

@Injectable()
export class AnalyticsQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async getReportDetails(id: string): Promise<unknown> {
    return this.prisma.analyticsReport.findUnique({
      where: { id },
      include: {
        exports: true,
      },
    });
  }

  async getReportsList(domain?: string, skip = 0, take = 50): Promise<unknown[]> {
    return this.prisma.analyticsReport.findMany({
      where: domain ? { domain } : undefined,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
  }

  async getDynamicKPIs(): Promise<unknown[]> {
    return this.prisma.analyticsMetric.findMany({
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getDashboardLayout(id: string): Promise<unknown> {
    return this.prisma.analyticsDashboard.findUnique({
      where: { id },
    });
  }
}
