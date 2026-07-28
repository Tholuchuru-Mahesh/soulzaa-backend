import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  ENTERPRISE_EVENT_QUEUES,
  EVENT_LIFECYCLE_CRON,
  EVENT_LIFECYCLE_JOB,
  EVENT_LIFECYCLE_JOB_ID,
} from '../constants/event-jobs.constants';

/**
 * Registers the event lifecycle sweep as a BullMQ repeatable job.
 *
 * `EventSchedulerService.processEventSchedules()` existed but was only reachable
 * by hand, so events never advanced out of SCHEDULED on their own — registration
 * windows and start/end times passed with no effect.
 *
 * The fixed `jobId` keeps one sweep running across the whole fleet rather than
 * one per pod.
 */
@Injectable()
export class EventLifecycleScheduler implements OnModuleInit {
  private readonly logger = new Logger(EventLifecycleScheduler.name);

  constructor(@InjectQueue(ENTERPRISE_EVENT_QUEUES.LIFECYCLE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        EVENT_LIFECYCLE_JOB,
        {},
        {
          repeat: { pattern: EVENT_LIFECYCLE_CRON },
          jobId: EVENT_LIFECYCLE_JOB_ID,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      this.logger.log(`Scheduled event lifecycle sweep (${EVENT_LIFECYCLE_CRON}).`);
    } catch (err) {
      this.logger.warn(`Event lifecycle schedule skipped: ${(err as Error).message}`);
    }
  }
}
