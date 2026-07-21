import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoRoomModerationActionType } from '@prisma/client';
import { Inject } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { LockService } from 'src/infra/redis/lock.service';
import { loadVideoRoomConfig } from '../config/video-room.config';
import {
  VIDEO_ROOM_ROLE_MONITOR_LOCK_KEY,
  VIDEO_ROOM_ROLE_SWEEP_BATCH,
} from '../constants/video-room.constants';
import { TemporaryRoleExpiredEvent } from '../events/video-room-role.events';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomRolesRepository } from '../repositories/video-room-roles.repository';
import { VideoRoomPermissionCache } from '../services/video-room-permission-cache.service';

/**
 * Sweeps lapsed temporary role grants (VR-7).
 *
 * This monitor is **not** the correctness mechanism. `VideoRoomRolesRepository
 * .findActive` already excludes an expired grant the instant it lapses, so
 * authorization is correct whether or not this ever runs — which matters,
 * because a background sweep is exactly the thing that silently stops working.
 * The sweep exists to emit the expiry events, write the audit record, and stop
 * the table growing.
 *
 * Lock-guarded so exactly one instance sweeps per tick across the fleet,
 * mirroring the session / seat / media monitors.
 */
@Injectable()
export class VideoRoomRoleMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoRoomRoleMonitor.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly intervalMs: number;

  constructor(
    private readonly roles: VideoRoomRolesRepository,
    private readonly moderation: VideoRoomModerationRepository,
    private readonly cache: VideoRoomPermissionCache,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    config: ConfigService,
  ) {
    this.intervalMs = loadVideoRoomConfig(config).cleanupIntervalSeconds * 1000;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    // Don't hold the event loop open for this background timer.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Delete every lapsed grant, announce it, and bump each affected room. */
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const release = await this.locks.acquire(VIDEO_ROOM_ROLE_MONITOR_LOCK_KEY, this.intervalMs);
      if (!release) return 0; // another instance is sweeping this tick
      try {
        return await this.purgeExpired();
      } finally {
        await release();
      }
    } catch (err) {
      this.logger.warn(`Video-room role sweep failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async purgeExpired(): Promise<number> {
    const expired = await this.roles.listExpired(new Date(), VIDEO_ROOM_ROLE_SWEEP_BATCH);
    if (expired.length === 0) return 0;

    const removed = await this.roles.deleteByIds(expired.map((grant) => grant.id));

    for (const grant of expired) {
      await this.moderation.appendAction({
        roomId: grant.roomId,
        // No moderator: the expiry is the system acting, not a person.
        moderatorId: null,
        targetUserId: grant.userId,
        action: VideoRoomModerationActionType.ROLE_REVOKED,
        reason: 'Temporary grant expired',
        metadata: { role: grant.role, automatic: true },
      });
      await this.bus.publish(
        new TemporaryRoleExpiredEvent({
          roomId: grant.roomId,
          userId: grant.userId,
          role: grant.role,
        }),
      );
    }

    // One bump per room, not per grant — the version is room-scoped, so bumping
    // twice for the same room would just orphan the cache a second time.
    for (const roomId of new Set(expired.map((grant) => grant.roomId))) {
      await this.cache.invalidateRoom(roomId);
    }

    this.logger.debug(`Swept ${removed} expired video-room role grant(s)`);
    return removed;
  }
}
