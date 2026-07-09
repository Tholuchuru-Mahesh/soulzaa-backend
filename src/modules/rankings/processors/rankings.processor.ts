import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY, QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { BaseQueueWorker } from 'src/infra/queue/workers/base-queue.worker';
import { QueueSupport } from 'src/infra/queue/workers/queue-support.service';
import { RankingsService } from '../services/rankings.service';

/**
 * Domain-owned worker for the RANKING_PROCESSING queue (kept in the rankings
 * module so infra stays independent of domains). Runs the daily leaderboard
 * snapshot enqueued by RankingsScheduler (`rankings.snapshot`).
 */
@Processor(QUEUE_NAMES.RANKING_PROCESSING, { concurrency: QUEUE_CONCURRENCY })
export class RankingsProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly rankings: RankingsService,
  ) {
    super(QUEUE_NAMES.RANKING_PROCESSING, support);
  }

  async handle(job: Job): Promise<unknown> {
    if (job.name === 'rankings.snapshot') {
      await this.rankings.takeMidnightSnapshots();
      return { snapshotTaken: true };
    }
    return { ok: true };
  }
}
