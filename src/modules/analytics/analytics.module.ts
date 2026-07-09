import { Module } from '@nestjs/common';
import { AnalyticsController } from './controllers/analytics.controller';
import { ANALYTICS_SERVICE } from './interfaces/analytics.service.interface';
import { AnalyticsActivityListener } from './listeners/analytics-activity.listener';
import { AnalyticsProcessor } from './processors/analytics.processor';
import { AnalyticsRepository } from './repositories/analytics.repository';
import { AnalyticsCountersService } from './services/analytics-counters.service';
import { AnalyticsReportingService } from './services/analytics-reporting.service';
import { AnalyticsRollupService } from './services/analytics-rollup.service';
import { AnalyticsScheduler } from './services/analytics.scheduler';
import { AnalyticsService } from './services/analytics.service';

/**
 * Analytics & Reporting (AR-13). Ingests source DomainEvents (room lifecycle,
 * voice/seat air-time, gifts) into durable aggregates + real-time Redis counters
 * (AnalyticsActivityListener + AnalyticsCountersService); a nightly BullMQ rollup
 * (AnalyticsScheduler → ANALYTICS_PROCESSING worker → AnalyticsRollupService)
 * materializes per-room and per-creator daily-stat tables. Reads: gated
 * room-owner reports and creator self-analytics (AnalyticsReportingService),
 * plus admin revenue reports. Owns the analytics aggregate, revenue, and daily
 * rollup tables plus the analytics Redis counters.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [
    AnalyticsRepository,
    AnalyticsService,
    AnalyticsCountersService,
    AnalyticsRollupService,
    AnalyticsReportingService,
    AnalyticsScheduler,
    AnalyticsProcessor,
    AnalyticsActivityListener,
    {
      provide: ANALYTICS_SERVICE,
      useClass: AnalyticsService,
    },
  ],
  exports: [AnalyticsRepository, AnalyticsService, AnalyticsRollupService, ANALYTICS_SERVICE],
})
export class AnalyticsModule {}
