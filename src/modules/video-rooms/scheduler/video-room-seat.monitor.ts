import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoRoomInvitationStatus, VideoRoomSeatRequestStatus } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { CacheService } from 'src/infra/redis/cache.service';
import { LockService } from 'src/infra/redis/lock.service';
import { loadVideoRoomConfig } from '../config/video-room.config';
import {
  VIDEO_ROOM_EXPIRY_SWEEP_LIMIT,
  VIDEO_ROOM_SEAT_MONITOR_LOCK_KEY,
  VIDEO_ROOM_SYSTEM_ACTOR_ID,
  videoRoomSeatReservationKey,
} from '../constants/video-room.constants';
import {
  SeatInvitationExpiredEvent,
  SeatRequestExpiredEvent,
} from '../events/video-room-seat.events';
import { VideoRoomSeatsRepository } from '../repositories/video-room-seats.repository';
import { VideoRoomSeatQueueService } from '../services/video-room-seat-queue.service';
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
    private readonly queue: VideoRoomSeatQueueService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
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
        const expiredRequests = await this.expireRequests(now);
        const expiredInvitations = await this.expireInvitations(now);

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

  /**
   * Expire stale requests one at a time so each can publish its own event —
   * the previous bulk `updateMany` returned only a count, so clients were never
   * told their request had lapsed. One row's failure does not abort the sweep.
   */
  private async expireRequests(now: Date): Promise<number> {
    const rows = await this.seats.listExpiredRequests(now, VIDEO_ROOM_EXPIRY_SWEEP_LIMIT);
    const touchedRooms = new Set<string>();
    let expired = 0;

    for (const row of rows) {
      try {
        await this.seats.setRequestStatus(
          row.id,
          VideoRoomSeatRequestStatus.EXPIRED,
          VIDEO_ROOM_SYSTEM_ACTOR_ID,
          VIDEO_ROOM_SYSTEM_ACTOR_ID,
        );
        await this.queue.dequeue(row.roomId, row.userId);
        await this.bus.publish(
          new SeatRequestExpiredEvent({
            roomId: row.roomId,
            requestId: row.id,
            userId: row.userId,
          }),
        );
        touchedRooms.add(row.roomId);
        expired += 1;
      } catch (err) {
        this.logger.warn(`Failed to expire seat request ${row.id}: ${(err as Error).message}`);
      }
    }

    for (const roomId of touchedRooms) {
      await this.queue.publishUpdate(roomId).catch(() => undefined);
    }
    return expired;
  }

  /** Expire stale invitations one at a time, publishing per row. */
  private async expireInvitations(now: Date): Promise<number> {
    const rows = await this.seats.listExpiredInvitations(now, VIDEO_ROOM_EXPIRY_SWEEP_LIMIT);
    let expired = 0;

    for (const row of rows) {
      try {
        await this.seats.setInvitationStatus(
          row.id,
          VideoRoomInvitationStatus.EXPIRED,
          VIDEO_ROOM_SYSTEM_ACTOR_ID,
        );
        await this.bus.publish(
          new SeatInvitationExpiredEvent({
            roomId: row.roomId,
            invitationId: row.id,
            inviteeUserId: row.inviteeUserId,
          }),
        );
        expired += 1;
      } catch (err) {
        this.logger.warn(`Failed to expire invitation ${row.id}: ${(err as Error).message}`);
      }
    }
    return expired;
  }
}
