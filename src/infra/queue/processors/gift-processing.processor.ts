import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY, QUEUE_NAMES } from '../queue.constants';
import { BaseQueueWorker } from '../workers/base-queue.worker';
import { QueueJobRegistry } from '../workers/queue-job.registry';
import { QueueSupport } from '../workers/queue-support.service';

/**
 * Gift queue transport. Owns no business logic — it routes each job to the
 * domain handler registered for its name (VR-10). Retries, backoff and
 * dead-lettering are inherited from BaseQueueWorker; jobs with no registered
 * handler are skipped rather than failed.
 */
@Processor(QUEUE_NAMES.GIFT_PROCESSING, { concurrency: QUEUE_CONCURRENCY })
export class GiftProcessingProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly registry: QueueJobRegistry,
  ) {
    super(QUEUE_NAMES.GIFT_PROCESSING, support);
  }

  async handle(job: Job): Promise<unknown> {
    return this.registry.dispatch(QUEUE_NAMES.GIFT_PROCESSING, job);
  }
}
