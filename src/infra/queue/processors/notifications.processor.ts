import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY, QUEUE_NAMES } from '../queue.constants';
import { BaseQueueWorker } from '../workers/base-queue.worker';
import { QueueSupport } from '../workers/queue-support.service';

/** Fan-out of in-app / push notifications. Real delivery wired in a later step. */
@Processor(QUEUE_NAMES.NOTIFICATIONS, { concurrency: QUEUE_CONCURRENCY })
export class NotificationsProcessor extends BaseQueueWorker {
  constructor(support: QueueSupport) {
    super(QUEUE_NAMES.NOTIFICATIONS, support);
  }

  async handle(job: Job): Promise<unknown> {
    this.logger.log(`[notifications] processing job ${job.id} (${job.name})`);
    return { ok: true };
  }
}
