import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY } from 'src/infra/queue/queue.constants';
import { BaseQueueWorker } from 'src/infra/queue/workers/base-queue.worker';
import { QueueSupport } from 'src/infra/queue/workers/queue-support.service';
import { CALL_JOBS, CALL_QUEUES, type CallDeadlineJob } from '../constants/calls.constants';
import { CallsService } from '../services/calls.service';

/**
 * Enforces the call deadlines: the ring window, the connect grace period, the hard
 * duration ceiling, and the periodic sweep that catches anything the delayed jobs
 * missed.
 *
 * The calls queue is its own — separate from the platform's shared `notifications`
 * queue — so a ring timeout can never sit behind a slow media-processing job. A
 * timeout that fires late is a phone that keeps ringing for a call nobody is on,
 * which is the one failure mode users notice instantly.
 *
 * Every handler is idempotent (the service's transitions are conditional), so a job
 * that fires twice, or races the reaper, settles the call exactly once.
 */
@Processor(CALL_QUEUES.CALLS, { concurrency: QUEUE_CONCURRENCY })
export class CallDeadlineProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly calls: CallsService,
  ) {
    super(CALL_QUEUES.CALLS, support);
  }

  async handle(job: Job<CallDeadlineJob>): Promise<unknown> {
    switch (job.name) {
      case CALL_JOBS.RING_TIMEOUT:
        await this.calls.expireRinging(job.data.callId);
        return { settled: job.data.callId };

      case CALL_JOBS.CONNECT_TIMEOUT:
        // The max-duration job shares this name and is told apart by its flag —
        // both are "a live call that has run out of time", one at each end of it.
        if (job.data.maxDuration) {
          await this.calls.expireConnected(job.data.callId);
        } else {
          await this.calls.expireConnecting(job.data.callId);
        }
        return { settled: job.data.callId };

      case CALL_JOBS.REAP:
        return this.calls.reap();

      default:
        this.logger.warn(`unknown calls job "${job.name}"`);
        return { skipped: job.name };
    }
  }
}
