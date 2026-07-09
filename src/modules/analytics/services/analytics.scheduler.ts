import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import {
  ANALYTICS_ROLLUP_CRON,
  ANALYTICS_ROLLUP_JOB,
  ANALYTICS_ROLLUP_JOB_ID,
} from '../constants/analytics.constants';

/**
 * Registers the daily analytics rollup as a BullMQ repeatable job (mirrors the
 * rankings scheduler). The ANALYTICS_PROCESSING worker consumes it and runs the
 * previous day's rollup.
 */
@Injectable()
export class AnalyticsScheduler implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsScheduler.name);

  constructor(private readonly queue: QueueService) {}

  async onModuleInit(): Promise<void> {
    await this.queue.schedule(
      QUEUE_NAMES.ANALYTICS_PROCESSING,
      ANALYTICS_ROLLUP_JOB,
      {},
      { pattern: ANALYTICS_ROLLUP_CRON },
      { jobId: ANALYTICS_ROLLUP_JOB_ID, removeOnComplete: true, removeOnFail: true },
    );
    this.logger.log(`Scheduled daily analytics rollup (${ANALYTICS_ROLLUP_CRON}).`);
  }
}
