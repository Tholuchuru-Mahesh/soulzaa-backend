import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY } from 'src/infra/queue/queue.constants';
import { BaseQueueWorker } from 'src/infra/queue/workers/base-queue.worker';
import { QueueSupport } from 'src/infra/queue/workers/queue-support.service';
import { DEVICE_QUEUES } from '../device.constants';
import { DeviceRepository } from '../repositories/device.repository';
import { PushDispatcher } from '../services/push/push.dispatcher';

/** Login-alert job payload enqueued by DeviceService on a suspicious login. */
export interface LoginAlertJob {
  userId: string;
  excludeDeviceId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Delivers push notifications off the device-owned `push` queue. Resolves the
 * target user's device push tokens (minus the originating device) and fans out
 * via the configured provider. Failures retry → dead-letter (BaseQueueWorker).
 */
@Processor(DEVICE_QUEUES.PUSH, { concurrency: QUEUE_CONCURRENCY })
export class PushProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly devices: DeviceRepository,
    private readonly dispatcher: PushDispatcher,
  ) {
    super(DEVICE_QUEUES.PUSH, support);
  }

  async handle(job: Job<LoginAlertJob>): Promise<unknown> {
    const { userId, excludeDeviceId, title, body, data } = job.data;
    const targets = await this.devices.pushTokensForUser(userId, excludeDeviceId);
    const delivered = await this.dispatcher.sendToTokens(
      targets.map((t) => t.pushToken),
      { title, body, data },
    );
    return { targets: targets.length, delivered };
  }
}
