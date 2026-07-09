import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY, QUEUE_NAMES } from '../queue.constants';
import { BaseQueueWorker } from '../workers/base-queue.worker';
import { QueueSupport } from '../workers/queue-support.service';

/** Transactional/marketing email delivery. Real mailer wired in a later step. */
@Processor(QUEUE_NAMES.EMAILS, { concurrency: QUEUE_CONCURRENCY })
export class EmailsProcessor extends BaseQueueWorker {
  constructor(support: QueueSupport) {
    super(QUEUE_NAMES.EMAILS, support);
  }

  async handle(job: Job): Promise<unknown> {
    this.logger.log(`[emails] processing job ${job.id} (${job.name})`);
    return { ok: true };
  }
}
