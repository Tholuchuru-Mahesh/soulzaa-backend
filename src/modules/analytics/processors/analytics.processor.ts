import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY, QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { BaseQueueWorker } from 'src/infra/queue/workers/base-queue.worker';
import { QueueSupport } from 'src/infra/queue/workers/queue-support.service';
import { ANALYTICS_ROLLUP_JOB } from '../constants/analytics.constants';
import { AnalyticsRollupService } from '../services/analytics-rollup.service';

/**
 * Domain-owned worker for the ANALYTICS_PROCESSING queue (kept in the analytics
 * module so infra stays independent of domains). Runs the nightly rollup
 * (`analytics.rollup`) and ingests queue-only source events (chat messages) into
 * the live counters. Other analytics jobs are accepted and no-op for now.
 */
@Processor(QUEUE_NAMES.ANALYTICS_PROCESSING, { concurrency: QUEUE_CONCURRENCY })
export class AnalyticsProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly rollup: AnalyticsRollupService,
  ) {
    super(QUEUE_NAMES.ANALYTICS_PROCESSING, support);
  }

  async handle(job: Job): Promise<unknown> {
    if (job.name === ANALYTICS_ROLLUP_JOB) {
      return { rolledUp: await this.rollup.runDailyRollup() };
    }
    if (job.name === 'chat.message') {
      const { roomId } = job.data as { roomId?: string };
      if (roomId) await this.rollup.recordChatMessage(roomId);
      return { recorded: true };
    }
    return { ok: true };
  }
}
