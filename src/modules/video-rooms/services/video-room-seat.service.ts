import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma, VideoRoomSeatStatus, VideoRoomSeatType, VideoRoomStatus } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import {
  buildSeatLayout,
  isOwnerSeat,
  type SeatLayoutEntry,
} from '../constants/video-room-seat-lifecycle';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { VIDEO_ROOM_MAX_SEATS, videoRoomSeatLockKey } from '../constants/video-room.constants';
import type { SeatStageView } from '../entities/video-room-seat-stage.view';
import {
  SeatLeftEvent,
  SeatLockedEvent,
  SeatSwitchedEvent,
  SeatTakenEvent,
  SeatTransferredEvent,
  SeatUnlockedEvent,
  SeatUpdatedEvent,
} from '../events/video-room-seat.events';
import type { SeatEntrySnapshot, SeatStageSnapshot } from '../interfaces/seat-stage.interface';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { toSeatStageView } from '../mappers/video-room-seat-stage.mapper';
import { VideoRoomSeatsRepository } from '../repositories/video-room-seats.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { LockService } from 'src/infra/redis/lock.service';
import { VideoRoomPermissionService } from './video-room-permission.service';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';
import { VideoRoomSeatStateService } from './video-room-seat-state.service';

/** Context threaded into the audit trail from the controller. */
export interface SeatAuditContext {
  ip?: string;
  requestId?: string;
}

/**
 * The multi-seat occupancy engine (VR-4). Every mutation runs the same pipeline
 * under `videoRoomSeatLockKey(roomId)`: load the authoritative Redis snapshot
 * (rebuild from DB if cold) → validate → commit the versioned snapshot (Redis, the
 * source of truth) → write-through `video_room_seats` (durable projection) → append
 * an immutable `video_room_events` audit row → publish a seat event on the bus (which
 * the socket + metrics listeners consume). The service never touches sockets.
 *
 * This class owns the shared occupancy primitives (`seatUser` / `vacateUser`) that the
 * request/invitation/lifecycle slices reuse; lock/layout and switch/transfer land in
 * the sibling method groups.
 */
@Injectable()
export class VideoRoomSeatService {
  constructor(
    protected readonly locks: LockService,
    protected readonly seatState: VideoRoomSeatStateService,
    protected readonly seats: VideoRoomSeatsRepository,
    protected readonly rooms: VideoRoomsRepository,
    protected readonly permissions: VideoRoomPermissionService,
    protected readonly events: VideoRoomEventsRepository,
    @Inject(EVENT_BUS) protected readonly bus: IEventBus,
  ) {}

  // ---- Reads ----

  /** The live seat stage (versioned snapshot + INVITED/REQUESTED overlays). No lock. */
  async getStage(_actor: RoomActor, roomId: string): Promise<SeatStageView> {
    const snapshot =
      (await this.seatState.getSnapshot(roomId)) ?? (await this.seatState.rebuild(roomId));
    return this.buildStageView(roomId, snapshot);
  }

  /** The first claimable open seat (EMPTY, unlocked, non-owner), or throws SEAT_FULL. */
  async findOpenSeat(actor: RoomActor, roomId: string): Promise<number> {
    const stage = await this.getStage(actor, roomId);
    const open = stage.seats.find(
      (s) => s.status === VideoRoomSeatStatus.EMPTY && !s.isLocked && !isOwnerSeat(s.seatIndex),
    );
    if (!open) {
      throw new BusinessException(
        ERROR_CODES.SEAT_FULL,
        'No open seat is available.',
        HttpStatus.CONFLICT,
      );
    }
    return open.seatIndex;
  }

  // ---- Occupancy verbs ----

  /** Claim an open seat for yourself (active member; open seating). */
  async takeSeat(
    actor: RoomActor,
    roomId: string,
    seatIndex: number,
    ip?: string,
  ): Promise<SeatStageView> {
    const room = await this.requireLiveRoom(roomId);
    await this.assertActiveMember(roomId, actor.id);
    return this.mutateStage(roomId, async (base) => {
      this.assertNotAlreadySeated(base, actor.id);
      const seat = this.requireSeat(base, seatIndex);
      this.assertClaimable(seat, actor.id, room.ownerId);
      return this.applyOccupy(roomId, base, seat, actor.id, actor.id, 'seat.taken', ip);
    });
  }

  /** Leave your current seat. */
  async leaveSeat(actor: RoomActor, roomId: string, ip?: string): Promise<SeatStageView> {
    await this.requireLiveRoom(roomId);
    return this.mutateStage(roomId, async (base) => {
      const seat = base.seats.find((s) => s.occupantUserId === actor.id);
      if (!seat) {
        throw new BusinessException(
          ERROR_CODES.NOT_ON_SEAT,
          'You are not on a seat.',
          HttpStatus.CONFLICT,
        );
      }
      return this.applyVacate(roomId, base, seat, actor.id, actor.id, 'seat.left', ip);
    });
  }

  // ---- Lock / unlock (bulk-capable; DISABLED/MAINTENANCE = LOCKED + reason) ----

  lockSeat(
    actor: RoomActor,
    roomId: string,
    seatIndex: number,
    reason?: string,
    ip?: string,
  ): Promise<SeatStageView> {
    return this.lockSeats(actor, roomId, [seatIndex], reason, ip);
  }

  unlockSeat(
    actor: RoomActor,
    roomId: string,
    seatIndex: number,
    ip?: string,
  ): Promise<SeatStageView> {
    return this.unlockSeats(actor, roomId, [seatIndex], ip);
  }

  async lockSeats(
    actor: RoomActor,
    roomId: string,
    seatIndexes: number[],
    reason?: string,
    ip?: string,
  ): Promise<SeatStageView> {
    const room = await this.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_SEATS);
    return this.mutateStage(roomId, async (base) => {
      for (const i of seatIndexes) {
        if (isOwnerSeat(i)) {
          throw new BusinessException(
            ERROR_CODES.SEAT_TYPE_FORBIDDEN,
            'The owner seat cannot be locked.',
            HttpStatus.BAD_REQUEST,
          );
        }
        this.requireSeat(base, i);
      }
      const targets = new Set(seatIndexes);
      const seats = base.seats.map((s) =>
        targets.has(s.seatIndex)
          ? {
              ...s,
              status: VideoRoomSeatStatus.LOCKED,
              isLocked: true,
              occupantUserId: null,
              reservedForUserId: null,
              reason: reason ?? null,
            }
          : s,
      );
      const next = await this.seatState.commit(roomId, base, { seats });
      for (const i of seatIndexes) {
        const entry = seats.find((s) => s.seatIndex === i)!;
        await this.seats.updateSeat(
          roomId,
          i,
          {
            seatStatus: VideoRoomSeatStatus.LOCKED,
            isLocked: true,
            occupantUserId: null,
            reservedForUserId: null,
            metadata: this.metadataFor(entry),
          },
          actor.id,
        );
        await this.audit(roomId, actor.id, 'seat.locked', {
          seatIndex: i,
          reason: reason ?? null,
          ip,
        });
        await this.bus.publish(
          new SeatLockedEvent({
            roomId,
            version: next.version,
            seatIndex: i,
            actorId: actor.id,
            reason: reason ?? null,
          }),
        );
      }
      return next;
    });
  }

  async unlockSeats(
    actor: RoomActor,
    roomId: string,
    seatIndexes: number[],
    ip?: string,
  ): Promise<SeatStageView> {
    const room = await this.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_SEATS);
    return this.mutateStage(roomId, async (base) => {
      for (const i of seatIndexes) this.requireSeat(base, i);
      const targets = new Set(seatIndexes);
      const seats = base.seats.map((s) =>
        targets.has(s.seatIndex)
          ? {
              ...s,
              status:
                s.status === VideoRoomSeatStatus.LOCKED ? VideoRoomSeatStatus.EMPTY : s.status,
              isLocked: false,
              reason: null,
            }
          : s,
      );
      const next = await this.seatState.commit(roomId, base, { seats });
      for (const i of seatIndexes) {
        const entry = seats.find((s) => s.seatIndex === i)!;
        await this.seats.updateSeat(
          roomId,
          i,
          { seatStatus: entry.status, isLocked: false, metadata: this.metadataFor(entry) },
          actor.id,
        );
        await this.audit(roomId, actor.id, 'seat.unlocked', { seatIndex: i, ip });
        await this.bus.publish(
          new SeatUnlockedEvent({
            roomId,
            version: next.version,
            seatIndex: i,
            actorId: actor.id,
          }),
        );
      }
      return next;
    });
  }

  // ---- Dynamic layout ----

  async configureLayout(
    actor: RoomActor,
    roomId: string,
    hostSeatCount: number,
    guestSeatCount: number,
    ip?: string,
  ): Promise<SeatStageView> {
    const room = await this.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_SEATS);
    const total = 1 + hostSeatCount + guestSeatCount;
    if (hostSeatCount < 0 || guestSeatCount < 0 || total > VIDEO_ROOM_MAX_SEATS) {
      throw new BusinessException(
        ERROR_CODES.SEAT_LAYOUT_INVALID,
        `A room supports at most ${VIDEO_ROOM_MAX_SEATS} seats (owner + hosts + guests).`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.mutateStage(roomId, async (base) => {
      await this.seats.setSeatLayout(roomId, hostSeatCount, guestSeatCount, actor.id);
      // Same index→seatType shape as room creation and the rebuild backfill — see
      // `buildSeatLayout`. Existing occupancy is carried over; only the type is re-derived.
      const layout = buildSeatLayout(hostSeatCount, guestSeatCount);
      const retyped: SeatLayoutEntry[] = [];
      const desired: SeatEntrySnapshot[] = layout.map(({ seatIndex, seatType }) => {
        const existing = base.seats.find((s) => s.seatIndex === seatIndex);
        if (existing && existing.seatType !== seatType) retyped.push({ seatIndex, seatType });
        return existing ? { ...existing, seatType } : this.emptyEntry(seatIndex, seatType);
      });
      await this.seats.createLayout(roomId, layout, actor.id);
      // `createLayout` is `createMany({ skipDuplicates: true })` — it INSERTS the indices
      // that don't exist yet and never UPDATES the ones that do. Seats are materialised at
      // room creation now, so on a reconfigure every index up to the old total already
      // exists and the insert is a no-op for them: without this loop a seat re-declared
      // HOST→GUEST would keep `seatType = HOST` in the DB while the snapshot said GUEST.
      // That desync is invisible through the API (reads come off the snapshot) but is read
      // straight from the row by `VideoRoomPermissionService.derive` (GUEST ⇒ PARTICIPANT,
      // anything else ⇒ HOST) and re-projected over the snapshot by the next `rebuild`.
      // Only genuinely-changed indices are written, and only `seatType` — occupancy, locks
      // and mute state are left exactly as they are.
      for (const { seatIndex, seatType } of retyped) {
        await this.seats.updateSeat(roomId, seatIndex, { seatType }, actor.id);
      }
      const displaced = base.seats.filter((s) => s.seatIndex >= total && s.occupantUserId);
      await this.seats.deleteSeatsFrom(roomId, total);
      const next = await this.seatState.commit(roomId, base, {
        seats: desired,
        hostSeatCount,
        guestSeatCount,
      });
      for (const s of displaced) {
        await this.bus.publish(
          new SeatLeftEvent({
            roomId,
            version: next.version,
            seatIndex: s.seatIndex,
            userId: s.occupantUserId as string,
          }),
        );
      }
      await this.audit(roomId, actor.id, 'seat.layout_changed', {
        hostSeatCount,
        guestSeatCount,
        ip,
      });
      await this.bus.publish(
        new SeatUpdatedEvent({
          roomId,
          version: next.version,
          seatIndex: null,
          reason: 'layout_changed',
        }),
      );
      return next;
    });
  }

  protected metadataFor(entry: SeatEntrySnapshot): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    const meta: Record<string, unknown> = {};
    if (entry.premium) meta.premium = true;
    if (entry.reason) meta.reason = entry.reason;
    return Object.keys(meta).length ? (meta as Prisma.InputJsonValue) : Prisma.JsonNull;
  }

  protected emptyEntry(seatIndex: number, seatType: VideoRoomSeatType): SeatEntrySnapshot {
    return {
      seatIndex,
      seatType,
      status: VideoRoomSeatStatus.EMPTY,
      occupantUserId: null,
      reservedForUserId: null,
      isLocked: false,
      isMuted: false,
      isVideoOn: false,
      reason: null,
      premium: false,
    };
  }

  // ---- Switch / transfer / remove ----

  /** Move your own occupancy to another (empty / self-reserved) seat, atomically. */
  async switchSeat(
    actor: RoomActor,
    roomId: string,
    toSeatIndex: number,
    ip?: string,
  ): Promise<SeatStageView> {
    const room = await this.requireLiveRoom(roomId);
    return this.mutateStage(roomId, async (base) => {
      const from = base.seats.find((s) => s.occupantUserId === actor.id);
      if (!from) {
        throw new BusinessException(
          ERROR_CODES.NOT_ON_SEAT,
          'You are not on a seat.',
          HttpStatus.CONFLICT,
        );
      }
      if (from.seatIndex === toSeatIndex) {
        throw new BusinessException(
          ERROR_CODES.SEAT_SWITCH_INVALID,
          'You are already on that seat.',
          HttpStatus.BAD_REQUEST,
        );
      }
      const to = this.requireSeat(base, toSeatIndex);
      this.assertClaimable(to, actor.id, room.ownerId);
      const seats = base.seats.map((s) => {
        if (s.seatIndex === from.seatIndex) {
          return { ...s, status: VideoRoomSeatStatus.EMPTY, occupantUserId: null };
        }
        if (s.seatIndex === toSeatIndex) {
          return {
            ...s,
            status: VideoRoomSeatStatus.OCCUPIED,
            occupantUserId: actor.id,
            reservedForUserId: null,
          };
        }
        return s;
      });
      const next = await this.seatState.commit(roomId, base, { seats });
      await this.seats.updateSeat(
        roomId,
        from.seatIndex,
        { seatStatus: VideoRoomSeatStatus.EMPTY, occupantUserId: null },
        actor.id,
      );
      await this.seats.updateSeat(
        roomId,
        toSeatIndex,
        {
          seatStatus: VideoRoomSeatStatus.OCCUPIED,
          occupantUserId: actor.id,
          reservedForUserId: null,
        },
        actor.id,
      );
      await this.audit(roomId, actor.id, 'seat.switched', {
        fromSeatIndex: from.seatIndex,
        toSeatIndex,
        ip,
      });
      await this.bus.publish(
        new SeatSwitchedEvent({
          roomId,
          version: next.version,
          userId: actor.id,
          fromSeatIndex: from.seatIndex,
          toSeatIndex,
        }),
      );
      return next;
    });
  }

  /** Move another user to a seat (owner/admin). `force` evicts the destination occupant. */
  async transferSeat(
    actor: RoomActor,
    roomId: string,
    userId: string,
    toSeatIndex: number,
    fromSeatIndex?: number,
    force = false,
    ip?: string,
  ): Promise<SeatStageView> {
    const room = await this.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_PARTICIPANTS);
    await this.permissions.assertOutranks(room, actor.id, userId);
    if (isOwnerSeat(toSeatIndex)) {
      throw new BusinessException(
        ERROR_CODES.SEAT_TYPE_FORBIDDEN,
        'The owner seat cannot be a transfer destination.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.mutateStage(roomId, async (base) => {
      const from = base.seats.find((s) => s.occupantUserId === userId);
      if (!from) {
        throw new BusinessException(
          ERROR_CODES.SEAT_TRANSFER_INVALID,
          'That user is not on a seat.',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (fromSeatIndex != null && from.seatIndex !== fromSeatIndex) {
        throw new BusinessException(
          ERROR_CODES.SEAT_TRANSFER_INVALID,
          'The user is not on the given source seat.',
          HttpStatus.CONFLICT,
        );
      }
      const to = this.requireSeat(base, toSeatIndex);
      if (to.isLocked || to.status === VideoRoomSeatStatus.LOCKED) {
        throw new BusinessException(
          ERROR_CODES.SEAT_LOCKED,
          'The destination seat is locked.',
          HttpStatus.CONFLICT,
        );
      }
      let displacedUserId: string | null = null;
      if (to.status === VideoRoomSeatStatus.OCCUPIED) {
        if (!force) {
          throw new BusinessException(
            ERROR_CODES.SEAT_TAKEN,
            'The destination seat is taken (use force to evict).',
            HttpStatus.CONFLICT,
          );
        }
        displacedUserId = to.occupantUserId;
      }
      if (to.status === VideoRoomSeatStatus.RESERVED && to.reservedForUserId !== userId && !force) {
        throw new BusinessException(
          ERROR_CODES.SEAT_RESERVED,
          'The destination seat is reserved.',
          HttpStatus.CONFLICT,
        );
      }
      const seats = base.seats.map((s) => {
        if (s.seatIndex === from.seatIndex) {
          return { ...s, status: VideoRoomSeatStatus.EMPTY, occupantUserId: null };
        }
        if (s.seatIndex === toSeatIndex) {
          return {
            ...s,
            status: VideoRoomSeatStatus.OCCUPIED,
            occupantUserId: userId,
            reservedForUserId: null,
          };
        }
        return s;
      });
      const next = await this.seatState.commit(roomId, base, { seats });
      await this.seats.updateSeat(
        roomId,
        from.seatIndex,
        { seatStatus: VideoRoomSeatStatus.EMPTY, occupantUserId: null },
        actor.id,
      );
      await this.seats.updateSeat(
        roomId,
        toSeatIndex,
        {
          seatStatus: VideoRoomSeatStatus.OCCUPIED,
          occupantUserId: userId,
          reservedForUserId: null,
        },
        actor.id,
      );
      if (displacedUserId) {
        await this.bus.publish(
          new SeatLeftEvent({
            roomId,
            version: next.version,
            seatIndex: toSeatIndex,
            userId: displacedUserId,
          }),
        );
      }
      await this.audit(roomId, actor.id, 'seat.transferred', {
        userId,
        fromSeatIndex: from.seatIndex,
        toSeatIndex,
        forced: force,
        ip,
      });
      await this.bus.publish(
        new SeatTransferredEvent({
          roomId,
          version: next.version,
          userId,
          fromSeatIndex: from.seatIndex,
          toSeatIndex,
          actorId: actor.id,
          forced: force,
        }),
      );
      return next;
    });
  }

  /** Remove a user from their seat (owner/admin; must outrank the target). */
  async removeFromSeat(
    actor: RoomActor,
    roomId: string,
    userId: string,
    ip?: string,
  ): Promise<SeatStageView> {
    const room = await this.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_PARTICIPANTS);
    await this.permissions.assertOutranks(room, actor.id, userId);
    return this.mutateStage(roomId, async (base) => {
      const seat = base.seats.find((s) => s.occupantUserId === userId);
      if (!seat) {
        throw new BusinessException(
          ERROR_CODES.NOT_ON_SEAT,
          'That user is not on a seat.',
          HttpStatus.CONFLICT,
        );
      }
      return this.applyVacate(roomId, base, seat, userId, actor.id, 'seat.removed', ip);
    });
  }

  // ---- Shared occupancy primitives (reused by request/invitation/lifecycle) ----

  /** Seat a specific user on a specific seat (admin-initiated: approve request / accept invite). */
  async seatUser(
    roomId: string,
    userId: string,
    actorId: string,
    seatIndex: number,
    ip?: string,
  ): Promise<SeatStageView> {
    const room = await this.requireLiveRoom(roomId);
    await this.assertActiveMember(roomId, userId);
    return this.mutateStage(roomId, async (base) => {
      this.assertNotAlreadySeated(base, userId);
      const seat = this.requireSeat(base, seatIndex);
      this.assertClaimable(seat, userId, room.ownerId);
      return this.applyOccupy(roomId, base, seat, userId, actorId, 'seat.taken', ip);
    });
  }

  /** Vacate a specific user's seat if they hold one (idempotent — no-op if unseated). */
  async vacateUser(
    roomId: string,
    userId: string,
    actorId: string,
    action: string,
    ip?: string,
  ): Promise<void> {
    await this.mutateStage(roomId, async (base) => {
      const seat = base.seats.find((s) => s.occupantUserId === userId);
      if (!seat) return base;
      return this.applyVacate(roomId, base, seat, userId, actorId, action, ip);
    });
  }

  // ---- Room lifecycle reactions (invoked by the seat lifecycle listener) ----

  /** A member left the room → free their seat if they held one. */
  async onMemberLeave(roomId: string, userId: string): Promise<void> {
    await this.vacateUser(roomId, userId, userId, 'seat.member_left');
  }

  /** The room closed / was deleted → drop the live snapshot (DB history is retained). */
  async onRoomClosed(roomId: string): Promise<void> {
    await this.seatState.clear(roomId);
  }

  // ---- Internal mechanics ----

  async mutateStage(
    roomId: string,
    fn: (base: SeatStageSnapshot) => Promise<SeatStageSnapshot>,
  ): Promise<SeatStageView> {
    const next = await this.locks.withLock(videoRoomSeatLockKey(roomId), async () => {
      const base =
        (await this.seatState.getSnapshot(roomId)) ?? (await this.seatState.rebuild(roomId));
      return fn(base);
    });
    return this.buildStageView(roomId, next);
  }

  protected async applyOccupy(
    roomId: string,
    base: SeatStageSnapshot,
    seat: SeatEntrySnapshot,
    userId: string,
    actorId: string,
    action: string,
    ip?: string,
  ): Promise<SeatStageSnapshot> {
    const seats = base.seats.map((s) =>
      s.seatIndex === seat.seatIndex
        ? {
            ...s,
            status: VideoRoomSeatStatus.OCCUPIED,
            occupantUserId: userId,
            reservedForUserId: null,
          }
        : s,
    );
    const next = await this.seatState.commit(roomId, base, { seats });
    await this.seats.updateSeat(
      roomId,
      seat.seatIndex,
      {
        seatStatus: VideoRoomSeatStatus.OCCUPIED,
        occupantUserId: userId,
        reservedForUserId: null,
      },
      actorId,
    );
    await this.audit(roomId, actorId, action, { seatIndex: seat.seatIndex, userId, ip });
    await this.bus.publish(
      new SeatTakenEvent({ roomId, version: next.version, seatIndex: seat.seatIndex, userId }),
    );
    return next;
  }

  protected async applyVacate(
    roomId: string,
    base: SeatStageSnapshot,
    seat: SeatEntrySnapshot,
    userId: string,
    actorId: string,
    action: string,
    ip?: string,
  ): Promise<SeatStageSnapshot> {
    const seats = base.seats.map((s) =>
      s.seatIndex === seat.seatIndex
        ? { ...s, status: VideoRoomSeatStatus.EMPTY, occupantUserId: null }
        : s,
    );
    const next = await this.seatState.commit(roomId, base, { seats });
    await this.seats.updateSeat(
      roomId,
      seat.seatIndex,
      { seatStatus: VideoRoomSeatStatus.EMPTY, occupantUserId: null },
      actorId,
    );
    await this.audit(roomId, actorId, action, { seatIndex: seat.seatIndex, userId, ip });
    await this.bus.publish(
      new SeatLeftEvent({ roomId, version: next.version, seatIndex: seat.seatIndex, userId }),
    );
    return next;
  }

  protected requireSeat(base: SeatStageSnapshot, seatIndex: number): SeatEntrySnapshot {
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

  protected assertNotAlreadySeated(base: SeatStageSnapshot, userId: string): void {
    if (base.seats.some((s) => s.occupantUserId === userId)) {
      throw new BusinessException(
        ERROR_CODES.ALREADY_ON_SEAT,
        'You are already on a seat.',
        HttpStatus.CONFLICT,
      );
    }
  }

  protected assertClaimable(seat: SeatEntrySnapshot, userId: string, ownerId: string): void {
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
    if (seat.status === VideoRoomSeatStatus.RESERVED && seat.reservedForUserId !== userId) {
      throw new BusinessException(
        ERROR_CODES.SEAT_RESERVED,
        'That seat is reserved for someone else.',
        HttpStatus.CONFLICT,
      );
    }
    if (isOwnerSeat(seat.seatIndex) && userId !== ownerId) {
      throw new BusinessException(
        ERROR_CODES.SEAT_TYPE_FORBIDDEN,
        'The owner seat is reserved for the room owner.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  async requireLiveRoom(roomId: string): Promise<{ id: string; ownerId: string }> {
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        'Room not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (room.status !== VideoRoomStatus.LIVE) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_INVALID_STATE,
        'The room is not live.',
        HttpStatus.CONFLICT,
      );
    }
    return { id: room.id, ownerId: room.ownerId };
  }

  /**
   * Public (not just `protected`): `VideoRoomSeatQueueService.assertQueueAccess`
   * calls this directly to gate the `GET .../seats/queue` read route, which has
   * no MANAGE_SEATS/INVITE_USERS permission check of its own.
   */
  async assertActiveMember(roomId: string, userId: string): Promise<void> {
    const member = await this.rooms.getMember(roomId, userId);
    if (!member?.isActive) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
        'You must join the room first.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  protected async audit(
    roomId: string,
    actorId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const clean = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
    await this.events.appendEvent({
      roomId,
      actorId,
      eventType,
      payload: clean as Prisma.InputJsonValue,
    });
  }

  protected async buildStageView(
    roomId: string,
    snapshot: SeatStageSnapshot,
  ): Promise<SeatStageView> {
    const [requests, invitations] = await Promise.all([
      this.seats.listPendingRequests(roomId),
      this.seats.listPendingInvitationsForRoom(roomId),
    ]);
    return toSeatStageView(snapshot, requests, invitations);
  }
}
