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
 * Delivers SMS OTPs off the `otp-sms` queue via the configured SMS provider,
 * then publishes `otp.sent`. Failures rethrow → BullMQ retry/backoff →
 * dead-letter (via BaseQueueWorker) for inspection.
 */
@Processor(OTP_QUEUES.SMS, { concurrency: QUEUE_CONCURRENCY })
export class OtpSmsProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly provider: OtpProvider,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {
    super(OTP_QUEUES.SMS, support);
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
