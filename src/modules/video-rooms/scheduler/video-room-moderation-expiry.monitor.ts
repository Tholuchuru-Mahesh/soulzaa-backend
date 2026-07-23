import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, VideoRoomModerationActionType, VideoRoomMute } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { LockService } from 'src/infra/redis/lock.service';
import { MODERATION_MONITOR_LOCK_KEY } from '../constants/video-room-moderation.constants';
import type { MuteChannel } from '../dto/moderation.dto';
import { UserUnmutedEvent } from '../events/video-room-moderation.events';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';

/**
 * Only `chat` mutes are a durable `VideoRoomMute` row with an `expiresAt`; a
 * `mic` mute delegates entirely to the media force-mute pipeline with no
 * persisted expiry (see `VideoRoomModerationService.mute`). So every row this
 * sweep lifts was only ever muting `chat`.
 */
const EXPIRED_MUTE_CHANNELS: MuteChannel[] = ['chat'];

/**
 * Reconciles expired temporary mutes (VR-16 Task 22): a `VideoRoomMute` row
 * created with an `expiresAt` (and its Redis mirror entry, which carries a
 * matching PX ttl) stays ACTIVE in the DB until this sweep lifts it, clears
 * the mirror, appends the audit row, and emits `UserUnmutedEvent`. Guarded by
 * a fleet-wide Redis lock so exactly one instance sweeps per tick — mirrors
 * the Audio Room's `ModerationExpiryMonitor` and this module's own
 * `VideoRoomSessionMonitor`. Blocks have no expiry (no ban/appeal concept in
 * Video Room moderation) so this monitor only ever touches mutes.
 */
@Injectable()
export class VideoRoomModerationExpiryMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoRoomModerationExpiryMonitor.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly repo: VideoRoomModerationRepository,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), this.intervalMs());
    // Don't hold the event loop open for this background timer.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
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

  /**
   * One sweep tick. Fleet-guarded by `MODERATION_MONITOR_LOCK_KEY` (a single
   * try — a losing instance simply skips this tick rather than waiting) and
   * by the `running` flag so this same instance never overlaps itself if a
   * previous tick is still draining a large backlog.
   */
  private async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const release = await this.locks.acquire(MODERATION_MONITOR_LOCK_KEY, this.intervalMs());
      if (!release) return; // another instance is sweeping this tick
      try {
        const now = new Date();
        const mutes = await this.repo.findExpiredMutes(now);
        for (const mute of mutes) {
          try {
            await this.liftExpiredMute(mute);
          } catch (err) {
            this.logger.warn(`Failed to expire mute ${mute.id}: ${(err as Error).message}`);
          }
        }
        if (mutes.length > 0) {
          this.logger.debug(`Expired ${mutes.length} mute(s)`);
        }
      } finally {
        await release();
      }
    } catch (err) {
      this.logger.warn(`Moderation expiry sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async liftExpiredMute(mute: VideoRoomMute): Promise<void> {
    await this.repo.liftMute(mute.id, mute.moderatorId);
    await this.repo.removeMuteMirror(mute.roomId, mute.userId);
    await this.repo.appendAction({
      roomId: mute.roomId,
      moderatorId: mute.moderatorId,
      targetUserId: mute.userId,
      action: VideoRoomModerationActionType.UNMUTE,
      reason: 'expired',
      metadata: { channels: EXPIRED_MUTE_CHANNELS } as Prisma.InputJsonValue,
    });
    await this.bus.publish(
      new UserUnmutedEvent({
        roomId: mute.roomId,
        moderatorId: mute.moderatorId,
        targetUserId: mute.userId,
        channels: EXPIRED_MUTE_CHANNELS,
        reason: 'expired',
      }),
    );
  }
}
