import { InjectQueue, Processor } from '@nestjs/bullmq';
import { OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { QUEUE_CONCURRENCY } from 'src/infra/queue/queue.constants';
import { BaseQueueWorker } from 'src/infra/queue/workers/base-queue.worker';
import { QueueSupport } from 'src/infra/queue/workers/queue-support.service';
import { VIDEO_ROOM_ANALYTICS_QUEUES } from '../constants/video-room-analytics.constants';
import { VideoRoomAnalyticsAggregationService } from '../services/video-room-analytics-aggregation.service';

@Processor(VIDEO_ROOM_ANALYTICS_QUEUES.AGGREGATION, { concurrency: QUEUE_CONCURRENCY })
export class VideoRoomAnalyticsAggregationProcessor
  extends BaseQueueWorker
  implements OnModuleInit
{
  constructor(
    @InjectQueue(VIDEO_ROOM_ANALYTICS_QUEUES.AGGREGATION) private readonly queue: Queue,
    support: QueueSupport,
    private readonly aggregationService: VideoRoomAnalyticsAggregationService,
  ) {
    super(VIDEO_ROOM_ANALYTICS_QUEUES.AGGREGATION, support);
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add('hourly-analytics', {}, { repeat: { pattern: '0 * * * *' } });
      await this.queue.add('daily-analytics', {}, { repeat: { pattern: '0 0 * * *' } });
      await this.queue.add('analytics-cleanup', {}, { repeat: { pattern: '0 2 * * *' } });
    } catch {
      // Swallowed on non-redis/mock testing environments
    }
  }

  async handle(job: Job): Promise<unknown> {
    switch (job.name) {
      case 'hourly-analytics':
      case 'analytics-aggregation':
        return this.aggregationService.aggregateHourly(job.data?.dateKey);
      case 'daily-analytics':
        return this.aggregationService.aggregateDaily(job.data?.dateKey);
      case 'weekly-analytics':
        return this.aggregationService.aggregateWeekly(job.data?.dateKey);
      case 'monthly-analytics':
        return this.aggregationService.aggregateMonthly(job.data?.dateKey);
      case 'analytics-cleanup':
      case 'cache-refresh':
        await this.aggregationService.refreshCache();
        return { ok: true, refreshed: true };
      default:
        return { ok: true, unhandled: true };
    }
  }
}
