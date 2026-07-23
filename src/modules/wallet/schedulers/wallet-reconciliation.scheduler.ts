import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { WALLET_JOBS } from '../constants/wallet.constants';

/**
 * Schedules the reconciliation sweep on the existing wallet-processing queue.
 * Daily at 03:15 — off-peak. No new queue; uses QueueService.schedule (cron).
 */
@Injectable()
export class WalletReconciliationScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(WalletReconciliationScheduler.name);
  constructor(private readonly queue: QueueService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.schedule(
      QUEUE_NAMES.WALLET_PROCESSING,
      WALLET_JOBS.RECONCILE_SWEEP,
      {},
      { pattern: '15 3 * * *' },
    );
    this.logger.log('wallet reconciliation sweep scheduled (daily 03:15)');
  }
}
