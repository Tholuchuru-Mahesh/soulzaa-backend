import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY, QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { BaseQueueWorker } from 'src/infra/queue/workers/base-queue.worker';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import { QueueSupport } from 'src/infra/queue/workers/queue-support.service';
import { RankingsService } from '../services/rankings.service';

/**
 * Domain-owned worker for the RANKING_PROCESSING queue (kept in the rankings
 * module so infra stays independent of domains).
 *
 * Two routing paths. `rankings.snapshot` — the platform daily snapshot — is
 * handled inline, exactly as before. Everything else is dispatched through
 * {@link QueueJobRegistry}, which is what lets a domain module (VR-13) own jobs
 * on this shared queue without editing this file again: BullMQ binds one
 * processor per queue name, so the registry is the only available seam. The
 * gift-processing queue already works this way for VR-12's PK timers.
 *
 * `dispatch` deliberately does not throw on an unregistered name — an unknown
 * job is a no-op, not a failure, so stray jobs cannot dead-letter themselves.
 */
@Processor(QUEUE_NAMES.RANKING_PROCESSING, { concurrency: QUEUE_CONCURRENCY })
export class RankingsProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly rankings: RankingsService,
    private readonly registry: QueueJobRegistry,
  ) {
    super(QUEUE_NAMES.RANKING_PROCESSING, support);
  }

  async handle(job: Job): Promise<unknown> {
    // 'rankings.snapshot' is reserved for this inline branch and is handled
    // here, not through the registry. A `registry.register('ranking-processing',
    // 'rankings.snapshot', ...)` call would succeed silently and its handler
    // would never fire, because this branch intercepts the name first.
    if (job.name === 'rankings.snapshot') {
      await this.rankings.takeMidnightSnapshots();
      return { snapshotTaken: true };
    }
    return this.registry.dispatch(QUEUE_NAMES.RANKING_PROCESSING, job);
  }
}
