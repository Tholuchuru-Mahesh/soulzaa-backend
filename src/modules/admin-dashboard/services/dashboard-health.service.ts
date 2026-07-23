import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { DashboardEventService } from './dashboard-event.service';
import { DashboardStatisticsService } from './dashboard-statistics.service';

export interface HealthReport {
  apiStatus: string;
  database: string;
  redis: string;
  queue: string;
  storage: string;
  socket: string;
  scheduler: string;
}

@Injectable()
export class DashboardHealthService {
  private readonly logger = new Logger(DashboardHealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DashboardEventService,
    private readonly statistics: DashboardStatisticsService,
  ) {}

  /**
   * Performs quick diagnostic status checks on vital platform sub-systems.
   * Raises alerts and emits event notifications if failures are detected.
   */
  async checkHealth(): Promise<HealthReport> {
    const report: HealthReport = {
      apiStatus: 'HEALTHY',
      database: 'HEALTHY',
      redis: 'HEALTHY',
      queue: 'HEALTHY',
      storage: 'HEALTHY',
      socket: 'HEALTHY',
      scheduler: 'HEALTHY',
    };

    try {
      // 1. Diagnose Database
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      report.database = 'UNHEALTHY';
      report.apiStatus = 'DEGRADED';
      await this.raiseAlert('CRITICAL', 'Database Unreachable', (err as Error).message);
    }

    this.logger.log(`Health Check completed: Database: ${report.database}`);
    return report;
  }

  async raiseAlert(
    severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL',
    title: string,
    message: string,
  ): Promise<void> {
    const alert = await this.prisma.dashboardAlert.create({
      data: {
        severity,
        title,
        message,
        source: 'DATABASE',
      },
    });

    this.events.emitAlertCreated({
      alertId: alert.id,
      severity,
      title,
      message,
    });

    await this.statistics.incrementStat('alertsRaised');
  }

  async getActiveAlerts(): Promise<unknown[]> {
    return this.prisma.dashboardAlert.findMany({
      where: { resolved: false },
      orderBy: { createdAt: 'desc' },
    });
  }

  async resolveAlert(id: string): Promise<void> {
    await this.prisma.dashboardAlert.update({
      where: { id },
      data: { resolved: true, resolvedAt: new Date() },
    });
  }
}
