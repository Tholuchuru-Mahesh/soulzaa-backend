import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LockService } from 'src/infra/redis/lock.service';
import { loadVideoRoomConfig, type VideoRoomConfig } from '../config/video-room.config';
import { VIDEO_ROOM_MEDIA_MONITOR_LOCK_KEY } from '../constants/video-room.constants';
import { VideoRoomMediaRecoveryService } from '../services/video-room-media-recovery.service';
import { VideoRoomMediaSessionRepository } from '../repositories/video-room-media-session.repository';

/**
 * Server-side network-recovery backstop for media sessions (VR-5), mirroring
 * VideoRoomSessionMonitor: periodically sweeps ACTIVE media sessions whose
 * heartbeat has gone stale. A session within the reconnect grace window moves
 * to RECOVERING (still salvageable); one past grace is force-expired. Guarded
 * by a short Redis lock so exactly one instance of the fleet sweeps per tick.
 */
@Injectable()
export class VideoRoomMediaMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoRoomMediaMonitor.name);
  private readonly cfg: VideoRoomConfig;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly locks: LockService,
    private readonly recovery: VideoRoomMediaRecoveryService,
    private readonly mediaSessions: VideoRoomMediaSessionRepository,
    config: ConfigService,
  ) {
    this.cfg = loadVideoRoomConfig(config);
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), this.cfg.mediaMonitorIntervalSeconds * 1000);
    // Don't hold the event loop open for this background timer.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const release = await this.locks.acquire(
        VIDEO_ROOM_MEDIA_MONITOR_LOCK_KEY,
        this.cfg.mediaMonitorIntervalSeconds * 1000,
      );
      if (!release) return; // another instance is sweeping this tick
      try {
        await this.sweep();
      } finally {
        await release();
      }
    } catch (err) {
      this.logger.warn(`Media sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** One sweep pass (exposed for tests). */
  async sweep(): Promise<void> {
    const now = Date.now();
    const graceMs =
      (this.cfg.mediaHeartbeatTtlSeconds + this.cfg.mediaReconnectGraceSeconds) * 1000;
    const cutoff = new Date(now - this.cfg.mediaHeartbeatTtlSeconds * 1000);
    const stale = await this.mediaSessions.findStale(cutoff, 200);
    for (const s of stale) {
      const last = new Date(s.lastHeartbeatAt).getTime();
      if (now - last > graceMs) {
        await this.recovery.expireRecovery(s.roomId, s.userId);
      } else {
        await this.recovery.markRecovering(s.roomId, s.userId);
      }
    }
  }
}
