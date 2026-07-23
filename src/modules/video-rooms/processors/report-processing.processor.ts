import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY, QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { BaseQueueWorker } from 'src/infra/queue/workers/base-queue.worker';
import { QueueSupport } from 'src/infra/queue/workers/queue-support.service';
import { VIDEO_ROOM_MODERATION_QUEUES } from '../constants/video-room-moderation.constants';

/** Shape of the one job this queue carries today: `{ type, ...payload }`. */
interface NotifyJobData {
  type: string;
  [key: string]: unknown;
}

/**
 * Transport worker for the moderation `REPORT` queue
 * (`VIDEO_ROOM_MODERATION_QUEUES.REPORT`) — report intake/aggregation.
 * `VideoRoomReportService.notifyRecipients` enqueues a `notify` job here
 * (via its own `@InjectQueue(VIDEO_ROOM_MODERATION_QUEUES.REPORT)`) whenever
 * a report is filed or system-flagged, instead of reaching the shared
 * `notifications` queue directly, so report fan-out gets its own
 * worker/retry/dead-letter lane rather than sharing `notifications`'.
 *
 * The only job name this queue carries is `notify`: forward it onto the
 * shared `NOTIFICATIONS` queue via `QueueService`, keyed by the original
 * `type` (e.g. `video_room.reported`) so the existing
 * `NotificationsProcessor` / `QueueJobRegistry` pipeline delivers it exactly
 * as it did when the service enqueued straight onto `notifications` (VR-16
 * carry-forward #1). Any other job name is a safe no-op.
 */
@Processor(VIDEO_ROOM_MODERATION_QUEUES.REPORT, { concurrency: QUEUE_CONCURRENCY })
export class ReportProcessingProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly notifications: QueueService,
  ) {
    super(VIDEO_ROOM_MODERATION_QUEUES.REPORT, support);
  }

  async handle(job: Job): Promise<unknown> {
    if (job.name !== 'notify') {
      return { ok: true, unhandled: true };
    }
    const { type, ...data } = job.data as NotifyJobData;
    return this.notifications.enqueue(QUEUE_NAMES.NOTIFICATIONS, type, data);
  }
}
