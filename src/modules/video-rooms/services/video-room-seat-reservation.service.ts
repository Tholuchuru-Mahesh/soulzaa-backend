import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { VideoRoomSeatStatus } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { CacheService } from 'src/infra/redis/cache.service';
import { isOwnerSeat } from '../constants/video-room-seat-lifecycle';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import {
  VIDEO_ROOM_RESERVATION_TTL_SECONDS,
  videoRoomSeatReservationKey,
} from '../constants/video-room.constants';
import type { SeatStageView } from '../entities/video-room-seat-stage.view';
import { SeatReleasedEvent, SeatReservedEvent } from '../events/video-room-seat.events';
import type { SeatStageSnapshot } from '../interfaces/seat-stage.interface';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';
import { VideoRoomSeatsRepository } from '../repositories/video-room-seats.repository';
import { VideoRoomPermissionService } from './video-room-permission.service';
import { VideoRoomSeatStateService } from './video-room-seat-state.service';
import { VideoRoomSeatService } from './video-room-seat.service';

/**
 * Seat reservation (VR-4): hold a seat for a specific user with an auto-releasing
 * TTL. The RESERVED status + `reservedForUserId` live in the authoritative snapshot
 * and the durable projection; a Redis hold key drives the expiry the seat monitor
 * reaps. Reuses `VideoRoomSeatService`'s locked stage pipeline (`mutateStage`).
 */
@Injectable()
export class VideoRoomSeatReservationService {
  constructor(
    private readonly seatSvc: VideoRoomSeatService,
    private readonly seatState: VideoRoomSeatStateService,
    private readonly seats: VideoRoomSeatsRepository,
    private readonly cache: CacheService,
    private readonly permissions: VideoRoomPermissionService,
    private readonly events: VideoRoomEventsRepository,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  /** Reserve a seat for a user (owner/admin), held for `ttlSeconds` before auto-release. */
  async reserve(
    actor: RoomActor,
    roomId: string,
    seatIndex: number,
    forUserId: string,
    ttlSeconds?: number,
    ip?: string,
  ): Promise<SeatStageView> {
    const room = await this.seatSvc.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_SEATS);
    if (isOwnerSeat(seatIndex)) {
      throw new BusinessException(
        ERROR_CODES.SEAT_TYPE_FORBIDDEN,
        'The owner seat cannot be reserved.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.seatSvc.mutateStage(roomId, async (base) => {
      const seat = this.requireSeat(base, seatIndex);
      if (seat.isLocked || seat.status === VideoRoomSeatStatus.LOCKED) {
        throw new BusinessException(
          ERROR_CODES.SEAT_LOCKED,
          'That seat is locked.',
          HttpStatus.CONFLICT,
        );
      }
      if (seat.status === VideoRoomSeatStatus.OCCUPIED) {
        throw new BusinessException(
          ERROR_CODES.SEAT_TAKEN,
          'That seat is taken.',
          HttpStatus.CONFLICT,
        );
      }
      if (seat.status === VideoRoomSeatStatus.RESERVED) {
        throw new BusinessException(
          ERROR_CODES.SEAT_RESERVED,
          'That seat is already reserved.',
          HttpStatus.CONFLICT,
        );
      }
      const seats = base.seats.map((s) =>
        s.seatIndex === seatIndex
          ? { ...s, status: VideoRoomSeatStatus.RESERVED, reservedForUserId: forUserId }
          : s,
      );
      const next = await this.seatState.commit(roomId, base, { seats });
      await this.seats.updateSeat(
        roomId,
        seatIndex,
        { seatStatus: VideoRoomSeatStatus.RESERVED, reservedForUserId: forUserId },
        actor.id,
      );
      const ttl = ttlSeconds ?? VIDEO_ROOM_RESERVATION_TTL_SECONDS;
      await this.cache.set(videoRoomSeatReservationKey(roomId, seatIndex), { forUserId }, ttl);
      await this.events.appendEvent({
        roomId,
        actorId: actor.id,
        eventType: 'seat.reserved',
        payload: { seatIndex, forUserId, ...(ip ? { ip } : {}) },
      });
      await this.bus.publish(
        new SeatReservedEvent({
          roomId,
          version: next.version,
          seatIndex,
          reservedForUserId: forUserId,
          actorId: actor.id,
        }),
      );
      return next;
    });
  }

  /** Cancel a reservation (owner/admin). */
  async cancelReservation(
    actor: RoomActor,
    roomId: string,
    seatIndex: number,
    ip?: string,
  ): Promise<SeatStageView> {
    const room = await this.seatSvc.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_SEATS);
    return this.seatSvc.mutateStage(roomId, async (base) => {
      const seat = this.requireSeat(base, seatIndex);
      if (seat.status !== VideoRoomSeatStatus.RESERVED) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_INVALID_STATE,
          'That seat is not reserved.',
          HttpStatus.CONFLICT,
        );
      }
      const next = await this.release(roomId, base, seatIndex, actor.id, 'cancelled', ip);
      return next;
    });
  }

  /**
   * Release a reservation whose TTL hold expired (called by the seat monitor).
   * Idempotent — returns false if the seat is no longer reserved (e.g. the holder
   * already took it). The audit is attributed to the lapsed holder.
   */
  async releaseExpired(roomId: string, seatIndex: number): Promise<boolean> {
    let released = false;
    await this.seatSvc.mutateStage(roomId, async (base) => {
      const seat = base.seats.find((s) => s.seatIndex === seatIndex);
      if (!seat || seat.status !== VideoRoomSeatStatus.RESERVED || !seat.reservedForUserId) {
        return base;
      }
      released = true;
      return this.release(roomId, base, seatIndex, seat.reservedForUserId, 'expired');
    });
    return released;
  }

  // ---- Internal ----

  private async release(
    roomId: string,
    base: SeatStageSnapshot,
    seatIndex: number,
    actorId: string,
    reason: 'cancelled' | 'expired',
    ip?: string,
  ): Promise<SeatStageSnapshot> {
    const seats = base.seats.map((s) =>
      s.seatIndex === seatIndex
        ? { ...s, status: VideoRoomSeatStatus.EMPTY, reservedForUserId: null }
        : s,
    );
    const next = await this.seatState.commit(roomId, base, { seats });
    await this.seats.updateSeat(
      roomId,
      seatIndex,
      { seatStatus: VideoRoomSeatStatus.EMPTY, reservedForUserId: null },
      actorId,
    );
    await this.cache.del(videoRoomSeatReservationKey(roomId, seatIndex));
    await this.events.appendEvent({
      roomId,
      actorId,
      eventType: 'seat.released',
      payload: { seatIndex, reason, ...(ip ? { ip } : {}) },
    });
    await this.bus.publish(
      new SeatReleasedEvent({ roomId, version: next.version, seatIndex, reason }),
    );
    return next;
  }

  private requireSeat(base: SeatStageSnapshot, seatIndex: number) {
    const seat = base.seats.find((s) => s.seatIndex === seatIndex);
    if (!seat) {
      throw new BusinessException(
        ERROR_CODES.SEAT_NOT_FOUND,
        `No seat at index ${seatIndex}.`,
        HttpStatus.NOT_FOUND,
      );
    }
    return seat;
  }
}
