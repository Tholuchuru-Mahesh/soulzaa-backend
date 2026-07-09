import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Job, JobsOptions, Queue } from 'bullmq';
import { DEAD_LETTER_QUEUE, QUEUE_NAMES, QueueName } from './queue.constants';
import type { DeadLetterPayload } from './workers/queue-support.service';

/** Repeat schedule: a cron `pattern` or a fixed `every` interval in ms. */
export type RepeatSpec = { pattern: string; every?: never } | { every: number; pattern?: never };

/**
 * Producer API for enqueuing work. Domain modules inject this to push jobs
 * (immediate, delayed, or repeatable) onto the shared queues, and to inspect /
 * replay the dead-letter queue.
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues: Map<string, Queue>;

  constructor(
    @InjectQueue(QUEUE_NAMES.NOTIFICATIONS) notifications: Queue,
    @InjectQueue(QUEUE_NAMES.EMAILS) emails: Queue,
    @InjectQueue(QUEUE_NAMES.GIFT_PROCESSING) gifts: Queue,
    @InjectQueue(QUEUE_NAMES.RANKING_PROCESSING) rankings: Queue,
    @InjectQueue(QUEUE_NAMES.ANALYTICS_PROCESSING) analytics: Queue,
    @InjectQueue(QUEUE_NAMES.MEDIA_PROCESSING) media: Queue,
    @InjectQueue(QUEUE_NAMES.WALLET_PROCESSING) wallet: Queue,
    @InjectQueue(DEAD_LETTER_QUEUE) private readonly deadLetter: Queue,
  ) {
    this.queues = new Map([
      [QUEUE_NAMES.NOTIFICATIONS, notifications],
      [QUEUE_NAMES.EMAILS, emails],
      [QUEUE_NAMES.GIFT_PROCESSING, gifts],
      [QUEUE_NAMES.RANKING_PROCESSING, rankings],
      [QUEUE_NAMES.ANALYTICS_PROCESSING, analytics],
      [QUEUE_NAMES.MEDIA_PROCESSING, media],
      [QUEUE_NAMES.WALLET_PROCESSING, wallet],
    ]);
  }

  /** Resolve a registered queue by name (throws if unknown). */
  getQueue(name: QueueName): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new NotFoundException(`Unknown queue "${name}"`);
    return queue;
  }

  /** Enqueue a job for immediate processing. */
  enqueue<T>(queue: QueueName, name: string, data: T, opts?: JobsOptions): Promise<Job> {
    return this.getQueue(queue).add(name, data, opts);
  }

  /** Enqueue a job that becomes available after `delayMs`. */
  enqueueDelayed<T>(
    queue: QueueName,
    name: string,
    data: T,
    delayMs: number,
    opts?: JobsOptions,
  ): Promise<Job> {
    return this.getQueue(queue).add(name, data, { ...opts, delay: delayMs });
  }

  /** Register a repeatable job (cron pattern or fixed interval). */
  schedule<T>(
    queue: QueueName,
    name: string,
    data: T,
    repeat: RepeatSpec,
    opts?: JobsOptions,
  ): Promise<Job> {
    return this.getQueue(queue).add(name, data, { ...opts, repeat });
  }

  /** Remove a previously registered repeatable job. */
  async removeSchedule(queue: QueueName, name: string, repeat: RepeatSpec): Promise<boolean> {
    return this.getQueue(queue).removeRepeatable(name, repeat);
  }

  getJobCounts(queue: QueueName): Promise<Record<string, number>> {
    return this.getQueue(queue).getJobCounts();
  }

  getDeadLetterJobCounts(): Promise<Record<string, number>> {
    return this.deadLetter.getJobCounts();
  }

  /** Jobs currently parked in the dead-letter queue. */
  getDeadLetterJobs(limit = 100): Promise<Job[]> {
    return this.deadLetter.getJobs(['waiting', 'delayed'], 0, Math.max(0, limit - 1));
  }

  /** Re-enqueue a dead-lettered job onto its original queue and drop it from the DLQ. */
  async replayDeadLetter(jobId: string): Promise<Job> {
    const dlqJob = await this.deadLetter.getJob(jobId);
    if (!dlqJob) throw new NotFoundException(`Dead-letter job "${jobId}" not found`);
    const payload = dlqJob.data as DeadLetterPayload;
    const replayed = await this.enqueue(
      payload.originalQueue as QueueName,
      payload.name,
      payload.data,
    );
    await dlqJob.remove();
    this.logger.log(`replayed dead-letter job ${jobId} onto "${payload.originalQueue}"`);
    return replayed;
  }

  /** True when the queue Redis connection is ready (used by the health indicator). */
  async isHealthy(): Promise<boolean> {
    const client = await this.deadLetter.client;
    return client.status === 'ready';
  }
}
