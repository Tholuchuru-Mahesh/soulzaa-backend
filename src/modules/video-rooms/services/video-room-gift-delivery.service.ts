import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import { LockService } from 'src/infra/redis/lock.service';
import {
  giftDeliverLockKey,
  VIDEO_ROOM_GIFT_EVENT_TYPES,
  VIDEO_ROOM_GIFT_QUEUE_JOB,
} from '../constants/video-room-gift.constants';
import {
  VideoRoomGiftAnimationEvent,
  VideoRoomGiftDeliveredEvent,
  VideoRoomGiftFailedEvent,
} from '../events/video-room-gift.events';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';
import { VideoRoomsMetrics } from '../video-rooms.metrics';
import type { VideoRoomGiftDeliveryJob } from './video-room-gift.service';

/** Outcome reported back to BullMQ. */
export interface GiftDeliveryResult {
  delivered: number;
}

/**
 * Delivers a committed gift batch: one animation trigger for the send, then one
 * delivery event per receiver leg (VR-10).
 *
 * Runs on the shared gift queue via the job registry, so it inherits BullMQ's
 * retry, backoff and dead-lettering rather than reimplementing them. Errors are
 * rethrown deliberately — that is what drives a retry, and eventually the DLQ
 * that the monitor can replay.
 */
@Injectable()
export class VideoRoomGiftDeliveryService implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomGiftDeliveryService.name);

  constructor(
    private readonly registry: QueueJobRegistry,
    private readonly locks: LockService,
    private readonly events: VideoRoomEventsRepository,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly metrics: VideoRoomsMetrics,
  ) {}

  onModuleInit(): void {
    this.registry.register(QUEUE_NAMES.GIFT_PROCESSING, VIDEO_ROOM_GIFT_QUEUE_JOB, (data, job) =>
      this.handle(data as VideoRoomGiftDeliveryJob, job),
    );
  }

  /**
   * Deliver one batch. The per-room lock guarantees gifts animate in the order
   * they were sent within a room, while different rooms still run in parallel —
   * BullMQ's own concurrency is global and gives no per-room ordering.
   */
  async handle(data: VideoRoomGiftDeliveryJob, job: Job): Promise<GiftDeliveryResult> {
    const jobId = String(job.id ?? '');
    const attempt = (job.attemptsMade ?? 0) + 1;

    return this.locks.withLock(giftDeliverLockKey(data.roomId), async () => {
      try {
        await this.broadcastAnimation(data, jobId, attempt);
        await this.deliverLegs(data, jobId, attempt);
        return { delivered: data.receiverIds.length };
      } catch (err) {
        await this.recordFailure(data, jobId, attempt, err as Error);
        // Rethrow so BullMQ retries and, once exhausted, dead-letters the job.
        throw err;
      }
    });
  }

  /** One animation per SEND — a stage-wide gift plays once, not N times. */
  private async broadcastAnimation(
    data: VideoRoomGiftDeliveryJob,
    jobId: string,
    attempt: number,
  ): Promise<void> {
    await this.bus.publish(
      new VideoRoomGiftAnimationEvent({
        batchId: data.batchId,
        transactionIds: data.transactionIds,
        receiverIds: data.receiverIds,
        roomId: data.roomId,
        senderId: data.senderId,
        giftId: data.giftId,
        jobId,
        attempt,
        giftName: data.giftName,
        animationUrl: data.animationUrl,
        soundUrl: data.soundUrl,
        comboTier: data.comboTier,
        quantity: data.quantity,
        totalCoinValue: data.totalCoinValue,
      }),
    );
  }

  /** One delivery event + audit row per receiver leg. */
  private async deliverLegs(
    data: VideoRoomGiftDeliveryJob,
    jobId: string,
    attempt: number,
  ): Promise<void> {
    for (const [index, receiverId] of data.receiverIds.entries()) {
      const transactionId = data.transactionIds[index] ?? data.transactionIds[0] ?? '';
      const correlation = {
        batchId: data.batchId,
        transactionId,
        roomId: data.roomId,
        senderId: data.senderId,
        receiverId,
        giftId: data.giftId,
        jobId,
        attempt,
      };

      await this.bus.publish(new VideoRoomGiftDeliveredEvent(correlation));
      await this.events.appendEvent({
        roomId: data.roomId,
        actorId: data.senderId,
        eventType: VIDEO_ROOM_GIFT_EVENT_TYPES.DELIVERED,
        payload: correlation,
        referenceId: transactionId,
        correlationId: data.batchId,
      });
    }
  }

  /**
   * Record the failure for every leg so the audit trail explains a missing
   * animation. Swallows its own errors: a failure to log must not mask the
   * original failure that BullMQ needs to see.
   */
  private async recordFailure(
    data: VideoRoomGiftDeliveryJob,
    jobId: string,
    attempt: number,
    error: Error,
  ): Promise<void> {
    this.logger.warn(
      `gift delivery attempt ${attempt} failed for batch ${data.batchId} (job ${jobId}): ${error.message}`,
    );
    this.metrics.incGiftFailure();
    try {
      for (const [index, receiverId] of data.receiverIds.entries()) {
        const transactionId = data.transactionIds[index] ?? '';
        const correlation = {
          batchId: data.batchId,
          transactionId,
          roomId: data.roomId,
          senderId: data.senderId,
          receiverId,
          giftId: data.giftId,
          jobId,
          attempt,
          reason: error.message,
        };
        await this.bus.publish(new VideoRoomGiftFailedEvent(correlation));
        await this.events.appendEvent({
          roomId: data.roomId,
          actorId: data.senderId,
          eventType: VIDEO_ROOM_GIFT_EVENT_TYPES.DELIVERY_FAILED,
          payload: correlation,
          referenceId: transactionId,
          correlationId: data.batchId,
        });
      }
    } catch (loggingError) {
      this.logger.error(
        `failed to record gift delivery failure for batch ${data.batchId}: ${
          (loggingError as Error).message
        }`,
      );
    }
  }
}
