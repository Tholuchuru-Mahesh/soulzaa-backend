import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  ENTERPRISE_RANKING_QUEUES,
  RANKING_SNAPSHOT_CRON,
  RANKING_SNAPSHOT_JOB,
  RANKING_SNAPSHOT_JOB_ID,
} from '../constants/ranking-jobs.constants';

/**
 * Registers the daily ranking snapshot as a BullMQ repeatable job.
 *
 * `RankingSnapshotService.takeAllSnapshots()` existed but nothing ever called it,
 * so historical ranking snapshots — the immutable record leaderboards are read
 * back from — were never actually taken.
 *
 * The fixed `jobId` keeps this idempotent across restarts and across the fleet:
 * BullMQ treats a repeatable job with the same id as the same schedule, so ten
 * pods produce one nightly snapshot rather than ten.
 */
@Injectable()
export class RankingScheduler implements OnModuleInit {
  private readonly logger = new Logger(RankingScheduler.name);

  constructor(@InjectQueue(ENTERPRISE_RANKING_QUEUES.SNAPSHOT) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        RANKING_SNAPSHOT_JOB,
        {},
        {
          repeat: { pattern: RANKING_SNAPSHOT_CRON },
          jobId: RANKING_SNAPSHOT_JOB_ID,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      this.logger.log(`Scheduled daily ranking snapshot (${RANKING_SNAPSHOT_CRON}).`);
    } catch (err) {
      this.logger.warn(`Ranking snapshot schedule skipped: ${(err as Error).message}`);
    }
  }
}
