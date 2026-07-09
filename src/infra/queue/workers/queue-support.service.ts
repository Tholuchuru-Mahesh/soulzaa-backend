import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { DEAD_LETTER_QUEUE } from '../queue.constants';
import { QueueMetrics } from '../queue.metrics';

/** Shape of a parked dead-letter job. */
export interface DeadLetterPayload {
  originalQueue: string;
  name: string;
  data: unknown;
  failedReason: string;
  attemptsMade: number;
  failedAt: string;
}

/**
 * Shared worker-side machinery: routes exhausted jobs to the dead-letter queue
 * and exposes the metrics helpers the base worker records against. Injected once
 * into every processor (via the base class) so processors stay thin.
 */
@Injectable()
export class QueueSupport {
  private readonly logger = new Logger(QueueSupport.name);

  constructor(
    @InjectQueue(DEAD_LETTER_QUEUE) private readonly deadLetter: Queue,
    readonly metrics: QueueMetrics,
  ) {}

  /** Park an exhausted job in the dead-letter queue for inspection/replay. */
  async deadLetterJob(originalQueue: string, job: Job): Promise<void> {
    const payload: DeadLetterPayload = {
      originalQueue,
      name: job.name,
      data: job.data,
      failedReason: job.failedReason ?? 'unknown',
      attemptsMade: job.attemptsMade,
      failedAt: new Date().toISOString(),
    };
    await this.deadLetter.add(`dlq:${originalQueue}`, payload);
    this.metrics.incDeadLettered(originalQueue);
    this.logger.warn(
      `job ${job.id} on "${originalQueue}" dead-lettered after ${job.attemptsMade} attempts`,
    );
  }
}
