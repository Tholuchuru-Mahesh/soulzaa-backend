import { Processor } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { BaseQueueWorker } from 'src/infra/queue/workers/base-queue.worker';
import { QueueSupport } from 'src/infra/queue/workers/queue-support.service';
import { OTP_QUEUES } from '../otp.constants';
import { OtpRepository } from '../repositories/otp.repository';

/**
 * Automatic cleanup: prunes OTP audit rows older than the retention window.
 * Driven by the repeatable `otp:cleanup` job registered by OtpScheduler. Live
 * Redis state self-expires via TTL, so this only sweeps the durable table.
 */
@Processor(OTP_QUEUES.MAINTENANCE, { concurrency: 1 })
export class OtpMaintenanceProcessor extends BaseQueueWorker {
  private readonly retentionHours: number;

  constructor(
    support: QueueSupport,
    private readonly repo: OtpRepository,
    config: ConfigService,
  ) {
    super(OTP_QUEUES.MAINTENANCE, support);
    this.retentionHours = Number(config.get('otp', { infer: true })!.retentionHours);
  }

  async handle(_job: Job): Promise<unknown> {
    const cutoff = new Date(Date.now() - this.retentionHours * 3600 * 1000);
    const pruned = await this.repo.pruneExpired(cutoff);
    if (pruned > 0) this.logger.log(`[otp-maintenance] pruned ${pruned} expired OTP records`);
    return { pruned };
  }
}
