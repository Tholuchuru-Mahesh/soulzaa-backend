import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY } from 'src/infra/queue/queue.constants';
import { BaseQueueWorker } from 'src/infra/queue/workers/base-queue.worker';
import { QueueSupport } from 'src/infra/queue/workers/queue-support.service';
import { VIDEO_ROOM_MODERATION_QUEUES } from '../constants/video-room-moderation.constants';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';

/**
 * Transport worker for the moderation `CLEANUP` queue
 * (`VIDEO_ROOM_MODERATION_QUEUES.CLEANUP`) — retention/expiry housekeeping.
 * Handles an `expire-mutes` job by bulk-flipping every ACTIVE temporary mute
 * past its `expiresAt` to EXPIRED (`VideoRoomModerationRepository
 * .expireMutes`, the same primitive Task 22's interval-driven expiry monitor
 * calls directly under a Redis lock). Idempotent: once a mute is EXPIRED it
 * no longer matches the `status = ACTIVE` filter, so replaying this job
 * (retry, duplicate delivery, or a manual ops-triggered sweep) is harmless —
 * it simply expires nothing further. Any other job name is a safe no-op.
 */
@Processor(VIDEO_ROOM_MODERATION_QUEUES.CLEANUP, { concurrency: QUEUE_CONCURRENCY })
export class ModerationCleanupProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly moderationRepo: VideoRoomModerationRepository,
  ) {
    super(VIDEO_ROOM_MODERATION_QUEUES.CLEANUP, support);
  }

  async handle(job: Job): Promise<unknown> {
    if (job.name !== 'expire-mutes') {
      return { ok: true, unhandled: true };
    }
    const expired = await this.moderationRepo.expireMutes(new Date());
    return { expired };
  }
}
