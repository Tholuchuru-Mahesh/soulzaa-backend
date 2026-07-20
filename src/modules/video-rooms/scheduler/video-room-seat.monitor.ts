import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from 'src/infra/redis/cache.service';
import { LockService } from 'src/infra/redis/lock.service';
import { loadVideoRoomConfig } from '../config/video-room.config';
import {
  VIDEO_ROOM_SEAT_MONITOR_LOCK_KEY,
  videoRoomSeatReservationKey,
} from '../constants/video-room.constants';
import { VideoRoomSeatsRepository } from '../repositories/video-room-seats.repository';
import { VideoRoomSeatReservationService } from '../services/video-room-seat-reservation.service';

/** Upper bound on RESERVED seats reconciled per sweep tick. */
const RESERVATION_SWEEP_LIMIT = 500;

/**
 * Fleet-locked expiry backstop for the seat slice (VR-4): bulk-expires stale PENDING
 * seat requests + invitations past their TTL, and releases reservations whose Redis
 * hold key has expired but whose seat still reads RESERVED (the authoritative flip
 * back to EMPTY + `seat_released` broadcast). Mirrors `VideoRoomSessionMonitor`: a
 * short Redis lock ensures exactly one instance sweeps per tick.
 */
@Injectable()
export class VideoRoomSeatMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoRoomSeatMonitor.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly intervalMs: number;

  constructor(
    private readonly seats: VideoRoomSeatsRepository,
    private readonly reservations: VideoRoomSeatReservationService,
    private readonly cache: CacheService,
    private readonly locks: LockService,
    config: ConfigService,
  ) {
    this.intervalMs = loadVideoRoomConfig(config).cleanupIntervalSeconds * 1000;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const release = await this.locks.acquire(VIDEO_ROOM_SEAT_MONITOR_LOCK_KEY, this.intervalMs);
      if (!release) return; // another instance is sweeping this tick
      try {
        const now = new Date();
        const [expiredRequests, expiredInvitations] = await Promise.all([
          this.seats.expireStaleRequests(now),
          this.seats.expireStaleInvitations(now),
        ]);

        let releasedReservations = 0;
        const reserved = await this.seats.listReservedSeats(RESERVATION_SWEEP_LIMIT);
        for (const seat of reserved) {
          const hold = await this.cache.get(
            videoRoomSeatReservationKey(seat.roomId, seat.seatIndex),
          );
          if (
            hold === null &&
            (await this.reservations.releaseExpired(seat.roomId, seat.seatIndex))
          ) {
            releasedReservations += 1;
          }
        }

        if (expiredRequests || expiredInvitations || releasedReservations) {
          this.logger.debug(
            `Seat sweep: ${expiredRequests} request(s), ${expiredInvitations} invitation(s), ` +
              `${releasedReservations} reservation(s) expired`,
          );
        }
      } finally {
        await release();
      }
    } catch (err) {
      this.logger.warn(`Video-room seat sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
