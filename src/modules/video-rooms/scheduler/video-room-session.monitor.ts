import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LockService } from 'src/infra/redis/lock.service';
import { loadVideoRoomConfig } from '../config/video-room.config';
import { VIDEO_ROOM_SESSION_MONITOR_LOCK_KEY } from '../constants/video-room.constants';
import { VideoRoomMemberService } from '../services/video-room-member.service';
import { VideoRoomSessionService } from '../services/video-room-session.service';

/**
 * Server-side network-recovery backstop (VR-0 foundation): periodically reclaims
 * video-room sessions whose client dropped without a clean leave (last seen older
 * than the reconnect grace window). The sweep is guarded by a short Redis lock so
 * exactly one instance runs it across the horizontally-scaled fleet. Client-side
 * auto-reconnect uses the socket layer's connectionStateRecovery; this reclaims
 * sessions that never come back. Mirrors the audio VoiceHeartbeatMonitor.
 */
@Injectable()
export class VideoRoomSessionMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoRoomSessionMonitor.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly intervalMs: number;
  private readonly reconnectTimeoutMs: number;

  constructor(
    private readonly sessions: VideoRoomSessionService,
    private readonly members: VideoRoomMemberService,
    private readonly locks: LockService,
    config: ConfigService,
  ) {
    const cfg = loadVideoRoomConfig(config);
    this.intervalMs = cfg.cleanupIntervalSeconds * 1000;
    this.reconnectTimeoutMs = cfg.reconnectTimeoutSeconds * 1000;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    // Don't hold the event loop open for this background timer.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const release = await this.locks.acquire(
        VIDEO_ROOM_SESSION_MONITOR_LOCK_KEY,
        this.intervalMs,
      );
      if (!release) return; // another instance is sweeping this tick
      try {
        const cutoff = new Date(Date.now() - this.reconnectTimeoutMs);
        const reclaimed = await this.sessions.expireStale(cutoff);
        for (const row of reclaimed) {
          // Member-level teardown + events run per reclaimed session so the sweep
          // both frees Redis and settles membership/counters/audit for each.
          await this.members.reclaim({
            roomId: row.roomId,
            userId: row.userId,
            socketId: row.socketId,
            joinedAt: row.joinedAt,
          });
        }
        if (reclaimed.length > 0) {
          this.logger.debug(`Reclaimed ${reclaimed.length} stale video-room session(s)`);
        }
      } finally {
        await release();
      }
    } catch (err) {
      this.logger.warn(`Video-room session sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
