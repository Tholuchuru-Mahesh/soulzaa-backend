import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { VIDEO_ROOM_RANKING_JOBS, errorMessage } from '../constants/video-room-ranking.constants';

/**
 * Cron patterns are staggered on purpose. Every one of these fires shortly
 * after a period boundary, and an unstaggered set would put the hourly, daily,
 * weekly, monthly and yearly recomputes on the same tick at 00:00 on New
 * Year's Day — the single busiest moment of the year for a gifting platform.
 * The offsets also give the previous window time to settle before it is read.
 */
const SCHEDULE: { name: string; pattern: string; jobId: string }[] = [
  { name: VIDEO_ROOM_RANKING_JOBS.AGGREGATE_HOURLY, pattern: '2 * * * *', jobId: 'vrank-hourly' },
  { name: VIDEO_ROOM_RANKING_JOBS.AGGREGATE_DAILY, pattern: '10 0 * * *', jobId: 'vrank-daily' },
  { name: VIDEO_ROOM_RANKING_JOBS.AGGREGATE_WEEKLY, pattern: '20 0 * * 1', jobId: 'vrank-weekly' },
  {
    name: VIDEO_ROOM_RANKING_JOBS.AGGREGATE_MONTHLY,
    pattern: '30 0 1 * *',
    jobId: 'vrank-monthly',
  },
  { name: VIDEO_ROOM_RANKING_JOBS.AGGREGATE_YEARLY, pattern: '40 0 1 1 *', jobId: 'vrank-yearly' },
  { name: VIDEO_ROOM_RANKING_JOBS.CACHE_REFRESH, pattern: '*/2 * * * *', jobId: 'vrank-cache' },
  { name: VIDEO_ROOM_RANKING_JOBS.CLEANUP, pattern: '50 3 * * *', jobId: 'vrank-cleanup' },
];

/**
 * Registers the VR-13 repeatable jobs, mirroring `RankingsScheduler`.
 *
 * A fixed `jobId` per entry is what makes this idempotent across restarts and
 * across every instance in the fleet: BullMQ treats a repeatable job with the
 * same id as the same schedule rather than adding another one, so a ten-pod
 * deployment ends up with one hourly aggregation, not ten.
 */
@Injectable()
export class VideoRoomRankingScheduler implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomRankingScheduler.name);

  constructor(private readonly queue: QueueService) {}

  async onModuleInit(): Promise<void> {
    for (const { name, pattern, jobId } of SCHEDULE) {
      try {
        await this.queue.schedule(
          QUEUE_NAMES.RANKING_PROCESSING,
          name,
          {},
          { pattern },
          { jobId, removeOnComplete: true, removeOnFail: true },
        );
        this.logger.log(`scheduled ${name} (${pattern})`);
      } catch (err) {
        // Never block boot on a scheduling failure — the app must still serve
        // reads even if the queue is briefly unreachable at startup.
        this.logger.error(`failed to schedule ${name}: ${errorMessage(err)}`);
      }
    }
  }
}
