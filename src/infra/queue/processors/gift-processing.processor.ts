import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY, QUEUE_NAMES } from '../queue.constants';
import { BaseQueueWorker } from '../workers/base-queue.worker';
import { QueueSupport } from '../workers/queue-support.service';

/** Gift settlement (coin deduction, wallet/analytics fan-out). Wired later. */
@Processor(QUEUE_NAMES.GIFT_PROCESSING, { concurrency: QUEUE_CONCURRENCY })
export class GiftProcessingProcessor extends BaseQueueWorker {
  constructor(support: QueueSupport) {
    super(QUEUE_NAMES.GIFT_PROCESSING, support);
  }

  async handle(job: Job): Promise<unknown> {
    this.logger.log(`[gift-processing] processing job ${job.id} (${job.name})`);
    return { ok: true };
  }
}
