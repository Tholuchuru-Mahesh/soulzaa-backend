import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { QueueService } from 'src/infra/queue/queue.service';
import { LockService } from 'src/infra/redis/lock.service';
import { loadVideoRoomTreasureConfig } from '../config/video-room-treasure.config';
import { VIDEO_ROOM_TREASURE_QUEUE_JOB } from '../constants/video-room-treasure.constants';
import { TreasureRecoveredEvent } from '../events/video-room-treasure.events';
import { VideoRoomsMetrics } from '../video-rooms.metrics';
import { VideoRoomTreasureRewardRepository } from '../repositories/video-room-treasure-reward.repository';
import { VideoRoomTreasureRepository } from '../repositories/video-room-treasure.repository';
import { VideoRoomTreasureUnlockService } from './video-room-treasure-unlock.service';

/** Fleet-wide sweep lock: many pods, one sweeper. */
const RECOVERY_LOCK_KEY = 'video-room:treasure:recovery';
/** Cap per sweep so a large backlog degrades gracefully instead of stalling a tick. */
const MAX_PER_SWEEP = 50;

/**
 * Reconciles unlocks that never finished (VR-11 spec §6.8).
 *
 * A box left UNLOCKING past the orphan timeout means the process died between
 * the claim — which committed with the gift — and the job running. BullMQ never
 * saw a job, so its own retry cannot help; only a sweep can. Re-running `handle`
 * is safe because the pool and winner unique constraints make it either
 * complete the work or exit as a replay.
 */
@Injectable()
export class VideoRoomTreasureRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoRoomTreasureRecoveryService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repo: VideoRoomTreasureRepository,
    private readonly rewards: VideoRoomTreasureRewardRepository,
    private readonly unlock: VideoRoomTreasureUnlockService,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
    private readonly queue: QueueService,
    private readonly metrics: VideoRoomsMetrics,
    @Optional() private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * The tick always runs; only the recovery ACTIONS are gated.
   *
   * Queue depth is an operational signal that must exist whether or not an
   * operator has opted into automatic replay — gating the timer on
   * `recoveryEnabled` (which defaults to false) left
   * `video_rooms_treasure_queue_depth` reporting zero forever in the default
   * configuration, which is worse than no metric at all.
   */
  onModuleInit(): void {
    const cfg = loadVideoRoomTreasureConfig(this.config);
    this.timer = setInterval(() => {
      void this.tick().catch((err) =>
        this.logger.warn(`Treasure recovery tick failed: ${(err as Error).message}`),
      );
    }, cfg.monitorIntervalSeconds * 1000);
    // Never hold the event loop open for a background sweep.
    this.timer.unref?.();
  }

  /** One monitor tick: always observe, act only when recovery is enabled. */
  async tick(): Promise<void> {
    await this.reportQueueDepth();
    await this.sweep();
  }

  /** Observability only — never gated, never throws out. */
  private async reportQueueDepth(): Promise<void> {
    try {
      const jobs = await this.queue.getDeadLetterJobs();
      this.metrics.setTreasureQueueDepth(
        jobs.filter((j) => (j.data as { name?: string })?.name === VIDEO_ROOM_TREASURE_QUEUE_JOB)
          .length,
      );
    } catch (err) {
      this.logger.warn(`Failed to read the dead-letter depth: ${(err as Error).message}`);
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<{ reclaimed: number; skipped: number; replayed: number }> {
    const cfg = loadVideoRoomTreasureConfig(this.config);
    if (!cfg.recoveryEnabled) return { reclaimed: 0, skipped: 0, replayed: 0 };

    return this.locks.withLock(RECOVERY_LOCK_KEY, async () => {
      const replayed = await this.replayDeadLettered();
      const cutoff = new Date(this.now() - cfg.orphanTimeoutSeconds * 1000);
      const orphans = await this.repo.findOrphanedBoxes(cutoff, MAX_PER_SWEEP);
      let reclaimed = 0;
      let skipped = 0;

      for (const box of orphans) {
        // A pool row proves the unlock already committed; the box is UNLOCKING
        // only because the process died after commit. Nothing to reclaim.
        if (await this.rewards.getPool(box.id)) {
          skipped += 1;
          continue;
        }

        const correlationId = `recovery:${box.id}`;
        try {
          await this.unlock.handle(
            {
              roomId: box.roomId,
              sessionId: box.sessionId,
              boxId: box.id,
              level: box.level,
              correlationId,
            },
            1,
          );
          reclaimed += 1;
          await this.bus.publish(
            new TreasureRecoveredEvent({
              correlationId,
              roomId: box.roomId,
              sessionId: box.sessionId,
              boxId: box.id,
              level: box.level,
              reason: 'ORPHAN_RECLAIM',
              attempt: 1,
            }),
          );
        } catch (err) {
          // One poisoned box must not stop the sweep reclaiming the rest.
          this.logger.warn(`Failed to reclaim treasure box ${box.id}: ${(err as Error).message}`);
        }
      }

      if (reclaimed > 0) {
        this.logger.log(`Reclaimed ${reclaimed} orphaned treasure unlock(s)`);
      }
      return { reclaimed, skipped, replayed };
    });
  }

  /**
   * Replays dead-lettered unlock jobs — the second failure shape (VR-11 §6.8).
   *
   * An orphan is a job that never existed; a dead-letter is a job that existed
   * and exhausted its retries. Only the latter is visible to BullMQ, and only
   * this path recovers it. Filtered by job name so a treasure sweep never
   * replays someone else's dead letters off the shared gift queue.
   *
   * Re-running is safe for the same reason the orphan path is: the pool and
   * winner unique constraints make a replay either finish the work or exit as a
   * no-op.
   */
  private async replayDeadLettered(): Promise<number> {
    let jobs: Awaited<ReturnType<QueueService['getDeadLetterJobs']>>;
    try {
      jobs = await this.queue.getDeadLetterJobs();
    } catch (err) {
      this.logger.warn(`Failed to read the dead-letter queue: ${(err as Error).message}`);
      return 0;
    }

    let replayed = 0;
    for (const job of jobs) {
      const payload = job.data as {
        name?: string;
        data?: Partial<{ roomId: string; sessionId: string; boxId: string; level: number }>;
      };
      if (payload?.name !== VIDEO_ROOM_TREASURE_QUEUE_JOB) continue;

      try {
        await this.queue.replayDeadLetter(String(job.id));
        replayed += 1;
        await this.bus.publish(
          new TreasureRecoveredEvent({
            correlationId: `dlq:${job.id}`,
            roomId: payload.data?.roomId ?? '',
            sessionId: payload.data?.sessionId ?? '',
            boxId: payload.data?.boxId,
            level: payload.data?.level,
            reason: 'DLQ_REPLAY',
            attempt: 1,
          }),
        );
      } catch (err) {
        // One unreplayable job must not stop the rest.
        this.logger.warn(
          `Failed to replay dead-lettered treasure job ${job.id}: ${(err as Error).message}`,
        );
      }
    }

    if (replayed > 0) this.logger.log(`Replayed ${replayed} dead-lettered treasure unlock(s)`);
    return replayed;
  }
}
