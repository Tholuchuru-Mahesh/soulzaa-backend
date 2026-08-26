import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import { type WealthResetResult, WealthMonthlyResetService } from './wealth-monthly-reset.service';

/** Job name on the shared notifications queue. */
export const WEALTH_MONTHLY_RESET_JOB = 'wealth.monthly-reset';

/** 00:05 on the 1st of each month — just after rollover, off-peak. */
export const WEALTH_MONTHLY_RESET_CRON = '5 0 1 * *';

/**
 * Registers the monthly Wealth Level rollover. Same mechanism as
 * `VipExpiryScheduler` (BullMQ repeatable job on the shared queue, stable
 * `jobId` for idempotent registration across restarts/instances).
 */
@Injectable()
export class WealthMonthlyResetScheduler implements OnModuleInit {
  private readonly logger = new Logger(WealthMonthlyResetScheduler.name);

  constructor(
    private readonly queue: QueueService,
    private readonly registry: QueueJobRegistry,
    private readonly reset: WealthMonthlyResetService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.register(
      QUEUE_NAMES.NOTIFICATIONS,
      WEALTH_MONTHLY_RESET_JOB,
      (): Promise<WealthResetResult> => this.reset.run(),
    );

    await this.queue.schedule(
      QUEUE_NAMES.NOTIFICATIONS,
      WEALTH_MONTHLY_RESET_JOB,
      {},
      { pattern: WEALTH_MONTHLY_RESET_CRON },
      { jobId: WEALTH_MONTHLY_RESET_JOB, removeOnComplete: true, removeOnFail: true },
    );

    this.logger.log(`Wealth Level monthly reset scheduled (${WEALTH_MONTHLY_RESET_CRON})`);
  }
}
