// src/modules/video-rooms/services/video-room-notification-fanout.service.ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import { RedisService } from 'src/infra/redis/redis.service';
import {
  SOCIAL_SERVICE,
  type ISocialService,
} from 'src/modules/social/interfaces/social.interface';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomNotificationMetrics } from '../metrics/video-room-notification.metrics';
import {
  VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_BOUNDS,
  VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_SIZE,
  VIDEO_ROOM_NOTIFICATION_FANOUT_CONFIG_KEY,
  VIDEO_ROOM_NOTIFICATION_FANOUT_JOB,
  VIDEO_ROOM_NOTIFICATION_MATRIX,
  videoRoomFanoutSentKey,
} from '../constants/video-room-notification.constants';
import {
  VideoRoomNotificationService,
  type VideoRoomFanoutJob,
} from './video-room-notification.service';

const SENT_SET_TTL_SECONDS = 24 * 60 * 60;

/**
 * Chunked followers fan-out (VR-15). One BullMQ job = one bounded chunk; it
 * resolves the next page of the owner's followers, delivers each (with the
 * dispatcher's own preference/mute gate), and re-enqueues the next cursor if
 * more remain. Redis SADD per (occurrence, user) makes it at-most-once across
 * retries — the sole delivery-idempotency mechanism. Retry/backoff/DLQ come from
 * BaseQueueWorker via the notifications processor.
 */
@Injectable()
export class VideoRoomNotificationFanoutService implements OnModuleInit {
  constructor(
    private readonly registry: QueueJobRegistry,
    private readonly queue: QueueService,
    @Inject(SOCIAL_SERVICE) private readonly social: ISocialService,
    private readonly redis: RedisService,
    private readonly dispatcher: VideoRoomNotificationService,
    private readonly config: ConfigService,
    private readonly rooms: VideoRoomsRepository,
    private readonly metrics: VideoRoomNotificationMetrics,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      QUEUE_NAMES.NOTIFICATIONS,
      VIDEO_ROOM_NOTIFICATION_FANOUT_JOB,
      (data: unknown) => this.handle(data as VideoRoomFanoutJob),
    );
  }

  private chunkSize(): number {
    const raw = Number(this.config.get(VIDEO_ROOM_NOTIFICATION_FANOUT_CONFIG_KEY));
    if (!Number.isFinite(raw) || raw <= 0) return VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_SIZE;
    // Enforce the validated [min, max] bounds (§7.1): too small ⇒ excessive job
    // churn (a job per follower), too large ⇒ long single-job runtime. Ops tune
    // within the band; a misconfiguration outside it is clamped, not honored.
    const { min, max } = VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_BOUNDS;
    return Math.min(max, Math.max(min, Math.trunc(raw)));
  }

  async handle(job: VideoRoomFanoutJob): Promise<void> {
    const take = this.chunkSize();
    const { ids, total } =
      job.source === 'MEMBERS'
        ? await this.rooms.pageActiveMemberIds(job.roomId, job.cursor, take)
        : await this.social.pageFollowerIds(job.ownerId, job.cursor, take);
    const row = VIDEO_ROOM_NOTIFICATION_MATRIX[job.kind];
    const sentKey = videoRoomFanoutSentKey(job.occurrenceId);

    const startedAt = Date.now();
    let delivered = 0;
    for (const userId of ids) {
      const fresh = await this.redis.client.sadd(sentKey, userId);
      if (fresh === 0) continue; // already delivered on a prior attempt
      await this.dispatcher.deliverOne(job.kind, row, userId, {
        roomId: job.roomId,
        actorId: job.ownerId,
        title: job.title,
        body: job.body,
        data: job.data,
      });
      delivered += 1;
    }
    await this.redis.client.expire(sentKey, SENT_SET_TTL_SECONDS);
    this.metrics.incFanoutRecipients(delivered);
    this.metrics.observeFanoutBatch((Date.now() - startedAt) / 1000);

    const next = job.cursor + take;
    if (next < total) {
      await this.queue.enqueue<VideoRoomFanoutJob>(
        QUEUE_NAMES.NOTIFICATIONS,
        VIDEO_ROOM_NOTIFICATION_FANOUT_JOB,
        { ...job, cursor: next },
        {
          jobId: `vrnotif:${job.occurrenceId}:${next}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
        },
      );
    }
  }
}
