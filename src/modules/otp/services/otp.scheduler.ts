import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { OTP_JOBS, OTP_QUEUES } from '../otp.constants';

/**
 * Registers the repeatable OTP-cleanup job on boot. Uses BullMQ repeatable jobs
 * (the platform's scheduling mechanism — @nestjs/schedule is not installed).
 * A stable `jobId` makes registration idempotent across restarts/instances, so
 * only one cleanup schedule ever exists.
 */
@Injectable()
export class OtpScheduler implements OnModuleInit {
  private readonly logger = new Logger(OtpScheduler.name);
  private readonly cron: string;

  constructor(
    @InjectQueue(OTP_QUEUES.MAINTENANCE) private readonly queue: Queue,
    config: ConfigService,
  ) {
    this.cron = config.get('otp', { infer: true })!.cleanupCron;
  }

  async onModuleInit(): Promise<void> {
    await this.queue.add(
      OTP_JOBS.CLEANUP,
      {},
      {
        repeat: { pattern: this.cron },
        jobId: OTP_JOBS.CLEANUP,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    this.logger.log(`OTP cleanup scheduled (${this.cron})`);
  }
}
