import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY } from 'src/infra/queue/queue.constants';
import { BaseQueueWorker } from 'src/infra/queue/workers/base-queue.worker';
import { QueueSupport } from 'src/infra/queue/workers/queue-support.service';
import { DEVICE_QUEUES } from '../device.constants';
import type { PushMessage } from '../interfaces/push-provider.interface';
import { DeviceRepository } from '../repositories/device.repository';
import { PushDispatcher } from '../services/push/push.dispatcher';

/**
 * A push addressed to a user rather than a token — the queue's only job shape.
 *
 * The message arrives **already resolved**: the recipient's notification
 * preferences were applied before it was enqueued (the notification module's
 * `PushPolicy`), so this worker never asks whether a push should be sent, only
 * where. Deciding that at enqueue time rather than delivery time is what keeps the
 * device module a transport and nothing more.
 *
 * `excludeDeviceId` is what makes a login alert an alert: it is skipped for the
 * device that just logged in, which is the one device that already knows. Every
 * other producer omits it and reaches all of the user's devices, which is what
 * multi-device delivery means.
 */
export interface UserPushJob extends PushMessage {
  userId: string;
  excludeDeviceId?: string;
}

/** @deprecated Kept as the historical name of the login-alert payload. */
export type LoginAlertJob = UserPushJob;

/**
 * Delivers push notifications off the device-owned `push` queue. Resolves the
 * target user's device push tokens (optionally minus the originating device) and
 * fans out via the configured provider. Failures retry → dead-letter
 * (BaseQueueWorker); tokens the provider declares permanently dead are retired by
 * the dispatcher rather than retried for the rest of time.
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

  async handle(job: Job<UserPushJob>): Promise<unknown> {
    const { userId, excludeDeviceId, ...message } = job.data;
    const targets = await this.devices.pushTokensForUser(userId, excludeDeviceId);
    if (targets.length === 0) return { targets: 0, delivered: 0, failed: 0, retired: 0 };

    const result = await this.dispatcher.sendToTokens(
      targets.map((t) => t.pushToken),
      message,
    );
    return { targets: targets.length, ...result };
  }
}
