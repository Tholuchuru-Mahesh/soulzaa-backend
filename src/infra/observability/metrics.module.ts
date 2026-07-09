import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsService } from './metrics.service';
import { MonitoringMetrics } from './monitoring.metrics';

/**
 * Prometheus metrics: the shared registry (MetricsService), the /metrics scrape
 * endpoint, the HTTP interceptor, and the per-subsystem metric families
 * (MonitoringMetrics: DB/Redis/Storage/Socket). Global so infra services can
 * inject MonitoringMetrics to record.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, MetricsInterceptor, MonitoringMetrics],
  exports: [MetricsService, MetricsInterceptor, MonitoringMetrics],
})
export class MetricsModule {}
