import { Processor } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Job } from 'bullmq';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { QUEUE_CONCURRENCY } from 'src/infra/queue/queue.constants';
import { BaseQueueWorker } from 'src/infra/queue/workers/base-queue.worker';
import { QueueSupport } from 'src/infra/queue/workers/queue-support.service';
import { OtpSentEvent } from '../events/otp.events';
import type { OtpDeliveryJob } from '../interfaces/otp.interface';
import { OTP_QUEUES } from '../otp.constants';
import { OtpProvider } from '../services/otp.provider';

/**
 * Delivers email OTPs off the `otp-email` queue via the configured email
 * provider, then publishes `otp.sent`. Failures retry → dead-letter.
 */
@Processor(OTP_QUEUES.EMAIL, { concurrency: QUEUE_CONCURRENCY })
export class OtpEmailProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly provider: OtpProvider,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {
    super(OTP_QUEUES.EMAIL, support);
  }

  async handle(job: Job<OtpDeliveryJob>): Promise<unknown> {
    const { channel, destination, code, purpose, otpRecordId } = job.data;
    const provider = await this.provider.deliver(channel, destination, code);
    await this.bus.publish(
      new OtpSentEvent({ destination, purpose, channel, otpRecordId, provider }),
    );
    return { delivered: true, provider };
  }
}
