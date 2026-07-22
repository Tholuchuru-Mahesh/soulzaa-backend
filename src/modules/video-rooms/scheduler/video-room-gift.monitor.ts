import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { QueueService } from 'src/infra/queue/queue.service';
import { LockService } from 'src/infra/redis/lock.service';
import {
  loadVideoRoomGiftConfig,
  type VideoRoomGiftConfig,
} from '../config/video-room-gift.config';
import {
  GIFT_MONITOR_LOCK_KEY,
  VIDEO_ROOM_GIFT_QUEUE_JOB,
} from '../constants/video-room-gift.constants';
import { VideoRoomGiftRecoveredEvent } from '../events/video-room-gift.events';
import { VideoRoomGiftComboService } from '../services/video-room-gift-combo.service';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/** What one tick did, returned for tests and logging. */
export interface GiftMonitorTickResult {
  combosClosed: number;
  jobsReplayed: number;
}

/**
 * Background maintenance for the gift engine (VR-10), mirroring the module's
 * other monitors: a lock-guarded interval so exactly one instance of the fleet
 * sweeps per tick.
 *
 * Two jobs:
 *  1. Close combos whose window has elapsed — an expiring Redis key emits
 *     nothing, so `giftComboEnded` needs a sweep to exist at all.
 *  2. Optionally replay dead-lettered delivery jobs. Replay is delegated to
 *     QueueService.replayDeadLetter; this class only decides *when*, so no
 *     retry/DLQ logic is duplicated here.
 */
@Injectable()
export class VideoRoomGiftMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoRoomGiftMonitor.name);
  private readonly cfg: VideoRoomGiftConfig;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly locks: LockService,
    private readonly combo: VideoRoomGiftComboService,
    private readonly queue: QueueService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly metrics: VideoRoomsMetrics,
    config: ConfigService,
  ) {
    this.cfg = loadVideoRoomGiftConfig(config);
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), this.cfg.monitorIntervalSeconds * 1000);
    // Don't hold the event loop open for this background timer.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One maintenance pass. Public so tests drive it without waiting on a timer. */
  async tick(): Promise<GiftMonitorTickResult> {
    if (this.running) return { combosClosed: 0, jobsReplayed: 0 };
    this.running = true;
    try {
      const result = await this.locks.withLock(GIFT_MONITOR_LOCK_KEY, async () => ({
        combosClosed: await this.sweepCombos(),
        jobsReplayed: await this.replayFailedDeliveries(),
      }));
      return result ?? { combosClosed: 0, jobsReplayed: 0 };
    } finally {
      this.running = false;
    }
  }

  private async sweepCombos(): Promise<number> {
    try {
      return await this.combo.sweepExpired();
    } catch (err) {
      this.logger.warn(`combo sweep failed: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * Replay dead-lettered video-room gift deliveries. Each replay gets a NEW
   * BullMQ job id, which is what distinguishes independent delivery runs for
   * the same batch (and is why no separate deliveryId exists).
   */
  private async replayFailedDeliveries(): Promise<number> {
    if (!this.cfg.recoveryEnabled) return 0;

    let jobs: Awaited<ReturnType<QueueService['getDeadLetterJobs']>>;
    try {
      jobs = await this.queue.getDeadLetterJobs();
    } catch (err) {
      this.logger.warn(`failed to read the dead-letter queue: ${(err as Error).message}`);
      return 0;
    }

    let replayed = 0;
    for (const job of jobs) {
      const payload = job.data as { name?: string; data?: { roomId?: string; batchId?: string } };
      if (payload?.name !== VIDEO_ROOM_GIFT_QUEUE_JOB) continue;

      try {
        await this.queue.replayDeadLetter(String(job.id));
        replayed += 1;
        this.metrics.incGiftRecovery('success');
        await this.bus.publish(
          new VideoRoomGiftRecoveredEvent({
            batchId: payload.data?.batchId ?? '',
            roomId: payload.data?.roomId ?? '',
            jobId: String(job.id),
          }),
        );
      } catch (err) {
        // One bad job must not stop the rest of the queue draining.
        this.metrics.incGiftRecovery('failure');
        this.logger.warn(`failed to replay gift job ${job.id}: ${(err as Error).message}`);
      }
    }
    return replayed;
  }
}
