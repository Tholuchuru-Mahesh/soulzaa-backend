import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';

@Injectable()
export class RankingsScheduler implements OnModuleInit {
  private readonly logger = new Logger(RankingsScheduler.name);
  private readonly cron = '5 0 * * *'; // Run daily at 00:05 AM

  constructor(private readonly queueService: QueueService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queueService.schedule(
        QUEUE_NAMES.RANKING_PROCESSING,
        'rankings.snapshot',
        {},
        { pattern: this.cron },
        {
          jobId: 'rankings-snapshot-job',
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      this.logger.log(`Rankings snapshot scheduled successfully (${this.cron})`);
    } catch (err) {
      this.logger.error(`Failed to schedule rankings snapshot: ${(err as Error).message}`);
    }
  }
}
