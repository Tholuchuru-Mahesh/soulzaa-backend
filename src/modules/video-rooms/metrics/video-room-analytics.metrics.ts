import { Injectable } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import { MetricsService } from 'src/infra/observability/metrics.service';

@Injectable()
export class VideoRoomAnalyticsMetrics {
  private readonly aggregationDuration: Histogram<'period'>;
  private readonly analyticsLatency: Histogram<'endpoint'>;
  private readonly cacheHits: Counter<string>;
  private readonly cacheMisses: Counter<string>;
  private readonly jobDuration: Histogram<'job'>;
  private readonly failures: Counter<'type'>;

  constructor(metrics: MetricsService) {
    const registers = [metrics.registry];

    this.aggregationDuration = new Histogram({
      name: 'video_rooms_analytics_aggregation_seconds',
      help: 'Duration of analytics aggregation jobs by period',
      labelNames: ['period'] as const,
      buckets: [0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30],
      registers,
    });

    this.analyticsLatency = new Histogram({
      name: 'video_rooms_analytics_latency_seconds',
      help: 'Latency of analytics query processing by endpoint',
      labelNames: ['endpoint'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
      registers,
    });

    this.cacheHits = new Counter({
      name: 'video_rooms_analytics_cache_hits_total',
      help: 'Total analytics cache hit count',
      registers,
    });

    this.cacheMisses = new Counter({
      name: 'video_rooms_analytics_cache_misses_total',
      help: 'Total analytics cache miss count',
      registers,
    });

    this.jobDuration = new Histogram({
      name: 'video_rooms_analytics_job_seconds',
      help: 'Duration of background analytics jobs',
      labelNames: ['job'] as const,
      buckets: [0.1, 0.5, 1, 2.5, 5, 10, 60],
      registers,
    });

    this.failures = new Counter({
      name: 'video_rooms_analytics_failures_total',
      help: 'Total analytics processing failures by type',
      labelNames: ['type'] as const,
      registers,
    });
  }

  observeAggregationDuration(period: string, seconds: number): void {
    this.aggregationDuration.observe({ period }, seconds);
  }

  observeAnalyticsLatency(endpoint: string, seconds: number): void {
    this.analyticsLatency.observe({ endpoint }, seconds);
  }

  incCacheHit(): void {
    this.cacheHits.inc();
  }

  incCacheMiss(): void {
    this.cacheMisses.inc();
  }

  observeJobDuration(job: string, seconds: number): void {
    this.jobDuration.observe({ job }, seconds);
  }

  incFailure(type: string): void {
    this.failures.inc({ type });
  }
}
