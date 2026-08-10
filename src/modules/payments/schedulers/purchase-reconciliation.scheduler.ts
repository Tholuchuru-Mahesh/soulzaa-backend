import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { PAYMENT_JOBS } from '../constants';

/**
 * Schedules the payments reconciliation sweep on the existing wallet-processing
 * queue — mirrors WalletReconciliationScheduler; no new queue, uses
 * QueueService.schedule (cron).
 *
 * Every 15 minutes rather than daily: the sweep's second pass retries Google
 * Play consumes that never landed, and until one lands the user cannot re-buy
 * that tier and gets a redelivered-purchase error on every app launch. A day of
 * that is a support ticket. The work is idempotent and normally scans zero rows.
 */
@Injectable()
export class PurchaseReconciliationScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(PurchaseReconciliationScheduler.name);

  constructor(private readonly queue: QueueService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.schedule(
      QUEUE_NAMES.WALLET_PROCESSING,
      PAYMENT_JOBS.RECONCILE_SWEEP,
      {},
      { pattern: '*/15 * * * *' },
    );
    this.logger.log('purchase reconciliation sweep scheduled (every 15 minutes)');
  }
}
