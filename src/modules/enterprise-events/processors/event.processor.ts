import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { BaseQueueWorker } from 'src/infra/queue/workers/base-queue.worker';
import { QueueSupport } from 'src/infra/queue/workers/queue-support.service';
import { ENTERPRISE_EVENT_QUEUES, EVENT_LIFECYCLE_JOB } from '../constants/event-jobs.constants';
import { EventSchedulerService } from '../services/event-scheduler.service';

/**
 * Sole worker for the enterprise events lifecycle queue. Concurrency is 1: the
 * sweep transitions events by time window, and two overlapping runs would race
 * on the same rows.
 */
@Processor(ENTERPRISE_EVENT_QUEUES.LIFECYCLE, { concurrency: 1 })
export class EnterpriseEventProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly scheduler: EventSchedulerService,
  ) {
    super(ENTERPRISE_EVENT_QUEUES.LIFECYCLE, support);
  }

  async handle(job: Job): Promise<unknown> {
    if (job.name === EVENT_LIFECYCLE_JOB) {
      return this.scheduler.processEventSchedules();
    }
    return { ok: true };
  }
}
