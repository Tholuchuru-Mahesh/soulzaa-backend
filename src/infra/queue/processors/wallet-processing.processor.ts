import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY, QUEUE_NAMES } from '../queue.constants';
import { BaseQueueWorker } from '../workers/base-queue.worker';
import { QueueSupport } from '../workers/queue-support.service';

/** Wallet mutations (coin credit/debit, ledger writes). Wired later. */
@Processor(QUEUE_NAMES.WALLET_PROCESSING, { concurrency: QUEUE_CONCURRENCY })
export class WalletProcessingProcessor extends BaseQueueWorker {
  constructor(support: QueueSupport) {
    super(QUEUE_NAMES.WALLET_PROCESSING, support);
  }

  async handle(job: Job): Promise<unknown> {
    this.logger.log(`[wallet-processing] processing job ${job.id} (${job.name})`);
    return { ok: true };
  }
}
