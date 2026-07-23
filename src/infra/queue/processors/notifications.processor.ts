import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY, QUEUE_NAMES } from '../queue.constants';
import { BaseQueueWorker } from '../workers/base-queue.worker';
import { QueueSupport } from '../workers/queue-support.service';
import { QueueJobRegistry } from '../workers/queue-job.registry';

/** Fan-out of in-app / push notifications — dispatches to registered handlers. */
@Processor(QUEUE_NAMES.NOTIFICATIONS, { concurrency: QUEUE_CONCURRENCY })
export class NotificationsProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly registry: QueueJobRegistry,
  ) {
    super(QUEUE_NAMES.NOTIFICATIONS, support);
  }

  async handle(job: Job): Promise<unknown> {
    return this.registry.dispatch(QUEUE_NAMES.NOTIFICATIONS, job);
  }
}
