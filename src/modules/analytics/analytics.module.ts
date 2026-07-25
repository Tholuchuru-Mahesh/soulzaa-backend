import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { AnalyticsController } from './controllers/analytics.controller';
import { AnalyticsEngineController } from './controllers/analytics-engine.controller';
import { ANALYTICS_SERVICE } from './interfaces/analytics.service.interface';
import { AnalyticsActivityListener } from './listeners/analytics-activity.listener';
import { AnalyticsProcessor } from './processors/analytics.processor';
import { AnalyticsRepository } from './repositories/analytics.repository';
import { AnalyticsCountersService } from './services/analytics-counters.service';
import { AnalyticsReportingService } from './services/analytics-reporting.service';
import { AnalyticsRollupService } from './services/analytics-rollup.service';
import { AnalyticsScheduler } from './services/analytics.scheduler';
import { AnalyticsService } from './services/analytics.service';

import { ReportService } from './services/report.service';
import { DashboardService } from './services/dashboard.service';
import { TrendService } from './services/trend.service';
import { ExportService } from './services/export.service';
import { AnalyticsStatisticsService } from './services/analytics-statistics.service';
import { AnalyticsAuditService } from './services/analytics-audit.service';
import { AnalyticsConfigurationService } from './services/analytics-configuration.service';
import { AnalyticsQueryService } from './services/analytics-query.service';
import { AnalyticsValidationService } from './services/analytics-validation.service';
import { AnalyticsCenterService } from './services/analytics-center.service';
import { AggregationService } from './services/aggregation.service';
import { AnalyticsEventService } from './services/analytics-event.service';

const ENTERPRISE_ANALYTICS_SERVICES = [
  ReportService,
  DashboardService,
  TrendService,
  ExportService,
  AnalyticsStatisticsService,
  AnalyticsAuditService,
  AnalyticsConfigurationService,
  AnalyticsQueryService,
  AnalyticsValidationService,
  AnalyticsCenterService,
  AggregationService,
  AnalyticsEventService,
];

@Module({
  imports: [PrismaModule],
  controllers: [AnalyticsController, AnalyticsEngineController],
  providers: [
    AnalyticsRepository,
    AnalyticsService,
    AnalyticsCountersService,
    AnalyticsRollupService,
    AnalyticsReportingService,
    AnalyticsScheduler,
    AnalyticsProcessor,
    AnalyticsActivityListener,
    ...ENTERPRISE_ANALYTICS_SERVICES,
    {
      provide: ANALYTICS_SERVICE,
      useClass: AnalyticsService,
    },
  ],
  exports: [
    AnalyticsRepository,
    AnalyticsService,
    AnalyticsRollupService,
    ANALYTICS_SERVICE,
    ...ENTERPRISE_ANALYTICS_SERVICES,
  ],
})
export class AnalyticsModule {}
