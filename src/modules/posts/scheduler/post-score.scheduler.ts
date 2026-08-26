import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import { PostScoreService } from '../services/post-score.service';

const POST_SCORE_DECAY_JOB = 'post.score.decay';

/**
 * Registers on the shared RANKING_PROCESSING queue through QueueJobRegistry —
 * the same seam VideoRoomRankingJobsService uses — rather than a dedicated
 * processor, since BullMQ binds only one processor per queue name.
 */
@Injectable()
export class PostScoreScheduler implements OnModuleInit {
  private readonly logger = new Logger(PostScoreScheduler.name);

  constructor(
    private readonly registry: QueueJobRegistry,
    private readonly queue: QueueService,
    private readonly scoring: PostScoreService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.register(QUEUE_NAMES.RANKING_PROCESSING, POST_SCORE_DECAY_JOB, () =>
      this.scoring.recomputeActivePosts(),
    );

    try {
      await this.queue.schedule(
        QUEUE_NAMES.RANKING_PROCESSING,
        POST_SCORE_DECAY_JOB,
        {},
        { pattern: '*/5 * * * *' },
        { jobId: 'post-score-decay', removeOnComplete: true, removeOnFail: true },
      );
      this.logger.log(`scheduled ${POST_SCORE_DECAY_JOB}`);
    } catch (err) {
      this.logger.error(`failed to schedule ${POST_SCORE_DECAY_JOB}: ${(err as Error).message}`);
    }
  }
}
