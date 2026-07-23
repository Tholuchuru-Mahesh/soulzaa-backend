import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { AggregationService } from './aggregation.service';
import { AnalyticsEventService } from './analytics-event.service';
import { AnalyticsConfigurationService } from './analytics-configuration.service';

@Injectable()
export class AnalyticsCenterService {
  private readonly logger = new Logger(AnalyticsCenterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aggregation: AggregationService,
    private readonly events: AnalyticsEventService,
    private readonly config: AnalyticsConfigurationService,
  ) {}

  /**
   * Captures time-series metrics snapshots across all active domains.
   */
  async captureSnapshots(): Promise<void> {
    this.logger.log('Beginning scheduled aggregation snapshot capture...');
    const domains = ['GROWTH', 'FINANCIAL', 'GIFT', 'REFERRAL', 'NOTIFICATION'];

    for (const domain of domains) {
      const metrics = await this.aggregation.aggregateDomainMetrics(domain);
      for (const [key, val] of Object.entries(metrics)) {
        const snapshot = await this.prisma.analyticsSnapshot.create({
          data: {
            domain,
            metricKey: key,
            metricValue: val,
          },
        });

        this.events.emitSnapshotCreated({
          domain,
          metricKey: key,
          metricValue: val,
          metadata: { snapshotId: snapshot.id },
        });
      }
    }
    this.logger.log('Aggregation snapshots successfully saved.');
  }

  /**
   * Purges snapshots and reports past dynamic retention policies.
   */
  async purgeExpired(): Promise<number> {
    const retentionDays = await this.config.getRetentionDays();
    const expiryDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    // Delete exports
    await this.prisma.reportExport.deleteMany({
      where: { createdAt: { lt: expiryDate } },
    });

    // Delete snapshots
    await this.prisma.analyticsSnapshot.deleteMany({
      where: { timestamp: { lt: expiryDate } },
    });

    // Delete reports
    const result = await this.prisma.analyticsReport.deleteMany({
      where: { createdAt: { lt: expiryDate } },
    });

    this.logger.log(`Purged ${result.count} expired analytics records.`);
    return result.count;
  }
}
