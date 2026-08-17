import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { LockService } from 'src/infra/redis/lock.service';
import {
  VOICE_HEARTBEAT_TTL_SECONDS,
  VOICE_MONITOR_INTERVAL_MS,
  VOICE_MONITOR_LOCK_KEY,
} from '../constants/voice.constants';
import { VoiceSessionRepository } from '../repositories/voice-session.repository';
import { AudioRoomsService } from './audio-rooms.service';
import { VoiceService } from './voice.service';

/**
 * Server-side network-recovery backstop: periodically ends voice sessions that
 * stopped sending heartbeats (client dropped without a clean leave), and sweeps
 * live audio rooms that have become empty to auto-end them.
 */
@Injectable()
export class VoiceHeartbeatMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VoiceHeartbeatMonitor.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly voice: VoiceSessionRepository,
    private readonly voiceService: VoiceService,
    private readonly locks: LockService,
    private readonly roomsService: AudioRoomsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), VOICE_MONITOR_INTERVAL_MS);
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
      const release = await this.locks.acquire(VOICE_MONITOR_LOCK_KEY, VOICE_MONITOR_INTERVAL_MS);
      if (!release) return; // another instance is sweeping this tick
      try {
        const cutoff = new Date(Date.now() - VOICE_HEARTBEAT_TTL_SECONDS * 1000);
        const stale = await this.voice.findStaleSessions(cutoff);
        for (const session of stale) {
          try {
            await this.voiceService.expireSession(session);
          } catch (err) {
            this.logger.warn(
              `Failed to expire stale voice session ${session.id}: ${(err as Error).message}`,
            );
          }
        }
        if (stale.length > 0) this.logger.debug(`Expired ${stale.length} stale voice session(s)`);

        // Sweep active LIVE rooms and auto-end any that have become empty
        await this.roomsService.autoEndEmptyRooms();
      } finally {
        await release();
      }
    } catch (err) {
      this.logger.warn(`Voice heartbeat sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
