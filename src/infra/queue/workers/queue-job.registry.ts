import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';

/** Domain logic for one queue job name. Receives the job data and the job. */
export type QueueJobHandler = (data: unknown, job: Job) => Promise<unknown>;

/**
 * Routes a queue job to the domain handler that owns it, keyed by
 * `${queue}:${jobName}`.
 *
 * BullMQ binds one processor per queue name, so a domain module cannot attach
 * its own worker to a shared queue. This registry is the seam: processors stay
 * pure transport, domain modules register on init, and a new gifting context
 * (live stream, private chat) plugs in without editing any processor.
 */
@Injectable()
export class QueueJobRegistry {
  private readonly logger = new Logger(QueueJobRegistry.name);
  private readonly handlers = new Map<string, QueueJobHandler>();

  private key(queue: string, jobName: string): string {
    return `${queue}:${jobName}`;
  }

  register(queue: string, jobName: string, handler: QueueJobHandler): void {
    const key = this.key(queue, jobName);
    if (this.handlers.has(key)) {
      throw new Error(`Queue job handler already registered: ${key}`);
    }
    this.handlers.set(key, handler);
    this.logger.log(`registered queue job handler: ${key}`);
  }

  /**
   * Run the handler for this job, or no-op when none is registered.
   *
   * An unknown job name MUST NOT throw. Several queues already receive jobs that
   * nothing consumes — `gift.sent` is enqueued on every audio-room gift and was
   * only ever swallowed by a stub processor. Throwing here would burn those
   * jobs' retries and dead-letter them, turning a harmless no-op into an alert
   * storm. Handler errors, by contrast, propagate so BullMQ can retry and
   * ultimately dead-letter a job that genuinely failed.
   */
  async dispatch(queue: string, job: Job): Promise<unknown> {
    const handler = this.handlers.get(this.key(queue, job.name));
    if (!handler) {
      this.logger.debug(`no handler for ${this.key(queue, job.name)} — skipping`);
      return { ok: true, unhandled: true };
    }
    return handler(job.data, job);
  }
}
