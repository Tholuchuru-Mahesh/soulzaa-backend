import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { VIDEO_ROOM_MODERATION_QUEUES } from '../constants/video-room-moderation.constants';

/**
 * Job name `ModerationCleanupProcessor` (`processors/moderation-cleanup.
 * processor.ts`) handles on the CLEANUP queue — must match exactly.
 */
export const MODERATION_CLEANUP_JOB = 'expire-mutes';

/**
 * Producer for `VIDEO_ROOM_MODERATION_QUEUES.CLEANUP` (VR-16 minor fix): the
 * queue + `ModerationCleanupProcessor` existed since Task 21/22 but nothing
 * ever enqueued to it, so the retention/expiry housekeeping lane sat dead.
 * Registers ONE repeatable `expire-mutes` job on boot, mirroring
 * `OtpScheduler`'s BullMQ-repeatable-job producer pattern (a stable `jobId`
 * makes registration idempotent across restarts and across every instance in
 * the fleet — BullMQ treats a repeatable job with the same id as the same
 * schedule rather than adding another one).
 *
 * Cadence reuses `videoRoom.moderation.expiryMonitorIntervalMs` — the same
 * config value `VideoRoomModerationExpiryMonitor`'s own direct, Redis-lock-
 * guarded sweep already reads for the identical "how often do we reconcile
 * expired mutes" question — rather than introducing a second, redundant
 * config knob for one cadence. That monitor performs the sweep synchronously
 * in-process; this queue-backed schedule gives the same idempotent
 * `expireMutes` primitive BullMQ's retry/backoff/observability/dead-letter
 * handling as a durable, fleet-distributed companion path.
 */
@Injectable()
export class VideoRoomModerationCleanupScheduler implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomModerationCleanupScheduler.name);

  constructor(
    @InjectQueue(VIDEO_ROOM_MODERATION_QUEUES.CLEANUP) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const every = this.intervalMs();
    await this.queue.add(
      MODERATION_CLEANUP_JOB,
      {},
      {
        repeat: { every },
        jobId: MODERATION_CLEANUP_JOB,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    this.logger.log(`Moderation cleanup scheduled every ${every}ms`);
  }

  private intervalMs(): number {
    const root = this.config.get<{ moderation?: { expiryMonitorIntervalMs?: number } }>(
      'videoRoom',
    );
    const ms = root?.moderation?.expiryMonitorIntervalMs;
    if (!ms) {
      throw new Error('videoRoom.moderation.expiryMonitorIntervalMs config is not registered');
    }
    return ms;
  }
}
