import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram } from 'prom-client';
import { MetricsService } from '../observability/metrics.service';

/**
 * BullMQ metrics registered on the shared Prometheus registry, so they are
 * exposed automatically at /metrics (no controller change). Gauges are sampled
 * periodically by QueueMonitorService; counters/histogram are updated by the
 * base worker as jobs complete/fail/dead-letter.
 */
@Injectable()
export class QueueMetrics {
  private readonly jobs: Gauge<'queue' | 'state'>;
  private readonly completed: Counter<'queue'>;
  private readonly failed: Counter<'queue'>;
  private readonly deadLettered: Counter<'queue'>;
  private readonly duration: Histogram<'queue'>;

  constructor(metrics: MetricsService) {
    const registers = [metrics.registry];
    this.jobs = new Gauge({
      name: 'bullmq_queue_jobs',
      help: 'Number of jobs in a queue by state',
      labelNames: ['queue', 'state'] as const,
      registers,
    });
    this.completed = new Counter({
      name: 'bullmq_jobs_completed_total',
      help: 'Total jobs completed',
      labelNames: ['queue'] as const,
      registers,
    });
    this.failed = new Counter({
      name: 'bullmq_jobs_failed_total',
      help: 'Total job attempts that failed',
      labelNames: ['queue'] as const,
      registers,
    });
    this.deadLettered = new Counter({
      name: 'bullmq_dead_lettered_total',
      help: 'Total jobs routed to the dead-letter queue',
      labelNames: ['queue'] as const,
      registers,
    });
    this.duration = new Histogram({
      name: 'bullmq_job_duration_seconds',
      help: 'Job processing duration in seconds',
      labelNames: ['queue'] as const,
      buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
      registers,
    });
  }

  setJobCounts(queue: string, counts: Record<string, number>): void {
    for (const [state, value] of Object.entries(counts)) {
      this.jobs.set({ queue, state }, value);
    }
  }

  observeDuration(queue: string, seconds: number): void {
    this.duration.observe({ queue }, seconds);
  }

  incCompleted(queue: string): void {
    this.completed.inc({ queue });
  }

  incFailed(queue: string): void {
    this.failed.inc({ queue });
  }

  incDeadLettered(queue: string): void {
    this.deadLettered.inc({ queue });
  }
}
