import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEAD_LETTER_QUEUE, JOB_QUEUE_NAMES, QueueName } from './queue.constants';
import { QueueMetrics } from './queue.metrics';
import { QueueService } from './queue.service';

/**
 * Periodically samples every queue's job counts into the Prometheus gauge so
 * `/metrics` reflects live queue depth (waiting/active/delayed/failed/...).
 * Interval is configurable via QUEUE_METRICS_INTERVAL_MS.
 */
@Injectable()
export class QueueMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueMonitorService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly queues: QueueService,
    private readonly metrics: QueueMetrics,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.config.get('queue.metricsIntervalMs', { infer: true })!;
    this.timer = setInterval(() => {
      void this.sample();
    }, intervalMs);
    // Don't keep the event loop alive just for metrics sampling.
    this.timer.unref();
    this.logger.log(`Queue metrics sampling every ${intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async sample(): Promise<void> {
    try {
      for (const name of JOB_QUEUE_NAMES) {
        this.metrics.setJobCounts(name, await this.queues.getJobCounts(name as QueueName));
      }
      this.metrics.setJobCounts(DEAD_LETTER_QUEUE, await this.queues.getDeadLetterJobCounts());
    } catch (err) {
      this.logger.warn(`Queue metrics sampling failed: ${(err as Error).message}`);
    }
  }
}
