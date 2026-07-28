import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_CONCURRENCY } from 'src/infra/queue/queue.constants';
import { BaseQueueWorker } from 'src/infra/queue/workers/base-queue.worker';
import { QueueSupport } from 'src/infra/queue/workers/queue-support.service';
import {
  ENTERPRISE_RANKING_QUEUES,
  RANKING_SNAPSHOT_JOB,
} from '../constants/ranking-jobs.constants';
import { RankingSnapshotService } from '../services/ranking-snapshot.service';

/**
 * Sole worker for the enterprise ranking engine's own queue.
 */
@Processor(ENTERPRISE_RANKING_QUEUES.SNAPSHOT, { concurrency: QUEUE_CONCURRENCY })
export class EnterpriseRankingProcessor extends BaseQueueWorker {
  constructor(
    support: QueueSupport,
    private readonly snapshots: RankingSnapshotService,
  ) {
    super(ENTERPRISE_RANKING_QUEUES.SNAPSHOT, support);
  }

  async handle(job: Job): Promise<unknown> {
    if (job.name === RANKING_SNAPSHOT_JOB) {
      const results = await this.snapshots.takeAllSnapshots();
      return { snapshots: results.length };
    }
    return { ok: true };
  }
}
