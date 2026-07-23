import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY, QUEUE_NAMES } from '../queue.constants';
import { BaseQueueWorker } from '../workers/base-queue.worker';
import { QueueJobRegistry } from '../workers/queue-job.registry';
import { QueueSupport } from '../workers/queue-support.service';

/** Wallet-processing queue: routes jobs to their registered domain handlers. */
@Processor(QUEUE_NAMES.WALLET_PROCESSING, { concurrency: QUEUE_CONCURRENCY })
export class WalletProcessingProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly registry: QueueJobRegistry,
  ) {
    super(QUEUE_NAMES.WALLET_PROCESSING, support);
  }

  async handle(job: Job): Promise<unknown> {
    return this.registry.dispatch(QUEUE_NAMES.WALLET_PROCESSING, job);
  }
}
