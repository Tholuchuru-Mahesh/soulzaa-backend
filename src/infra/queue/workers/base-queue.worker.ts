import { OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { FORCE_FAIL_FLAG } from '../queue.constants';
import { QueueSupport } from './queue-support.service';

/**
 * Base for every queue processor. Wraps `process()` with timing + metrics,
 * lets BullMQ handle retries (by rethrowing), and routes a job to the
 * dead-letter queue once its attempts are exhausted. Concrete processors only
 * declare `@Processor(name)` and implement `handle(job)`.
 */
export abstract class BaseQueueWorker extends WorkerHost {
  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    protected readonly queueName: string,
    protected readonly support: QueueSupport,
  ) {
    super();
  }

  /** Domain logic for a job. Implemented by each processor. */
  abstract handle(job: Job): Promise<unknown>;

  async process(job: Job): Promise<unknown> {
    const startedAt = Date.now();
    try {
      // Reserved hook to exercise the retry → dead-letter path (see FORCE_FAIL_FLAG).
      if ((job.data as Record<string, unknown>)?.[FORCE_FAIL_FLAG]) {
        throw new Error('forced failure (test hook)');
      }
      const result = await this.handle(job);
      this.support.metrics.observeDuration(this.queueName, (Date.now() - startedAt) / 1000);
      this.support.metrics.incCompleted(this.queueName);
      return result;
    } catch (err) {
      this.support.metrics.incFailed(this.queueName);
      throw err; // rethrow so BullMQ applies attempts/backoff
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job?: Job): Promise<void> {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      await this.support.deadLetterJob(this.queueName, job);
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    this.logger.debug(`job ${job.id} (${job.name}) completed on "${this.queueName}"`);
  }
}
