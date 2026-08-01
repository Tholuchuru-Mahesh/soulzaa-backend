import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import { VipExpiryService, type VipSweepResult } from './vip-expiry.service';

/** Job name on the shared notifications queue. */
export const VIP_EXPIRY_SWEEP_JOB = 'vip.expiry-sweep';

/** 03:00 daily — off-peak, and a few hours of lag on an expiry warning is fine. */
export const VIP_EXPIRY_CRON = '0 3 * * *';

/**
 * Registers the daily VIP expiry sweep.
 *
 * Uses BullMQ repeatable jobs, the platform's scheduling mechanism
 * (`@nestjs/schedule` is not installed — see `OtpScheduler`). A stable `jobId`
 * makes registration idempotent across restarts and across instances, so only
 * one schedule ever exists no matter how many containers boot.
 *
 * The work itself is registered through `QueueJobRegistry` rather than a new
 * processor: BullMQ binds one processor per queue name, so a domain module
 * cannot attach its own worker to the shared `notifications` queue.
 */
@Injectable()
export class VipExpiryScheduler implements OnModuleInit {
  private readonly logger = new Logger(VipExpiryScheduler.name);

  constructor(
    private readonly queue: QueueService,
    private readonly registry: QueueJobRegistry,
    private readonly expiry: VipExpiryService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.register(
      QUEUE_NAMES.NOTIFICATIONS,
      VIP_EXPIRY_SWEEP_JOB,
      (): Promise<VipSweepResult> => this.expiry.sweep(),
    );

    await this.queue.schedule(
      QUEUE_NAMES.NOTIFICATIONS,
      VIP_EXPIRY_SWEEP_JOB,
      {},
      { pattern: VIP_EXPIRY_CRON },
      { jobId: VIP_EXPIRY_SWEEP_JOB, removeOnComplete: true, removeOnFail: true },
    );

    this.logger.log(`VIP expiry sweep scheduled (${VIP_EXPIRY_CRON})`);
  }
}
