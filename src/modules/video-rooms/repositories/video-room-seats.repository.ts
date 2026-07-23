import { Injectable } from '@nestjs/common';
import {
  Prisma,
  VideoRoomInvitation,
  VideoRoomInvitationStatus,
  VideoRoomInvitationType,
  VideoRoomSeat,
  VideoRoomSeatRequest,
  VideoRoomSeatRequestStatus,
  VideoRoomSeatStatus,
  VideoRoomSeatType,
} from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  VIDEO_ROOM_DEFAULT_GUEST_SEATS,
  VIDEO_ROOM_DEFAULT_HOST_SEATS,
} from '../constants/video-room.constants';

/** One seat in a room's initial stage layout (built at room creation). */
export interface SeatLayoutEntry {
  seatIndex: number;
  seatType: VideoRoomSeatType;
}

export interface CreateSeatRequestInput {
  roomId: string;
  userId: string;
  seatIndex?: number | null;
  expiresAt?: Date | null;
}

export interface CreateInvitationInput {
  roomId: string;
  inviterId: string;
  inviteeUserId: string;
  type?: VideoRoomInvitationType;
  seatIndex?: number | null;
  expiresAt: Date;
}

/** VR-8 — optional extras when transitioning a seat request. */
export interface SetRequestStatusOptions {
  /** Failure reason to persist (null clears a previous one). */
  lastError?: string | null;
  /** Increment `attemptCount` as part of this transition. */
  bumpAttempt?: boolean;
  /**
   * I6 — compare-and-swap guard: only write if the row is CURRENTLY in this
   * status. Omitted → unconditional `update` (today's behaviour, unchanged).
   * Provided → an `updateMany({ where: { id, status: expectedFrom } })`; a
   * `count` of 0 means another actor already moved the row, and the caller
   * gets `null` back instead of a silently-overwritten write.
   */
  expectedFrom?: VideoRoomSeatRequestStatus;
}

/** VR-8 — optional extras when transitioning an invitation. */
export interface SetInvitationStatusOptions {
  lastError?: string | null;
  bumpAttempt?: boolean;
  /** Stamp the delivery acknowledgement time (used with status DELIVERED). */
  deliveredAt?: Date;
  /** I6 — compare-and-swap guard; see `SetRequestStatusOptions.expectedFrom`. */
  expectedFrom?: VideoRoomInvitationStatus;
}

/**
 * Persistence for the multi-seat video stage: `video_room_seats`,
 * `video_room_seat_requests`, `video_room_invitations`. Pure persistence — seat
 * occupancy rules, request/invite acceptance, and the associated broadcasts live
 * in the (later) seat service. Seat uniqueness ((room,seatIndex) and
 * (room,occupantUserId)) is enforced by the DB; "one PENDING request per user" is
 * enforced by the caller under a lock.
 */
@Injectable()
export class VideoRoomSeatsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Seats ----

  /** Create a room's initial seat layout in one batch (idempotent per room via
   * the (roomId,seatIndex) unique index — callers create once at room creation). */
  async createLayout(roomId: string, layout: SeatLayoutEntry[], actorId: string): Promise<number> {
    const { count } = await this.prisma.videoRoomSeat.createMany({
      data: layout.map((s) => ({
        roomId,
        seatIndex: s.seatIndex,
        seatType: s.seatType,
        ...auditCreate(actorId),
      })),
      skipDuplicates: true,
    });
    return count;
  }

  /** All seats in a room, ordered by index. */
  async listSeats(roomId: string): Promise<VideoRoomSeat[]> {
    return this.prisma.videoRoomSeat.findMany({
      where: { roomId },
      orderBy: { seatIndex: 'asc' },
    });
  }

  /** A single seat by (room,index), or null. */
  async findSeat(roomId: string, seatIndex: number): Promise<VideoRoomSeat | null> {
    return this.prisma.videoRoomSeat.findUnique({
      where: { roomId_seatIndex: { roomId, seatIndex } },
    });
  }

  /** Patch a seat's state (occupancy / lock / mute / video / status). */
  async updateSeat(
    roomId: string,
    seatIndex: number,
    data: Prisma.VideoRoomSeatUpdateInput,
    actorId: string,
  ): Promise<VideoRoomSeat> {
    return this.prisma.videoRoomSeat.update({
      where: { roomId_seatIndex: { roomId, seatIndex } },
      data: { ...data, ...auditUpdate(actorId) },
    });
  }

  /** The seat a user currently occupies in a room, or null. */
  async findOccupiedSeat(roomId: string, userId: string): Promise<VideoRoomSeat | null> {
    return this.prisma.videoRoomSeat.findFirst({
      where: { roomId, occupantUserId: userId },
    });
  }

  // ---- Seat requests ----

  async createRequest(
    input: CreateSeatRequestInput,
    actorId: string,
  ): Promise<VideoRoomSeatRequest> {
    return this.prisma.videoRoomSeatRequest.create({
      data: {
        roomId: input.roomId,
        userId: input.userId,
        seatIndex: input.seatIndex ?? null,
        expiresAt: input.expiresAt ?? null,
        ...auditCreate(actorId),
      },
    });
  }

  /** Pending requests for a room, oldest first. */
  async listPendingRequests(roomId: string): Promise<VideoRoomSeatRequest[]> {
    return this.prisma.videoRoomSeatRequest.findMany({
      where: { roomId, status: VideoRoomSeatRequestStatus.PENDING },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** A user's current PENDING request in a room, or null. */
  async findPendingRequest(roomId: string, userId: string): Promise<VideoRoomSeatRequest | null> {
    return this.prisma.videoRoomSeatRequest.findFirst({
      where: { roomId, userId, status: VideoRoomSeatRequestStatus.PENDING },
    });
  }

  /** VR-8 — the user's most recent request in a room, whatever its status. */
  async findLatestRequestForUser(
    roomId: string,
    userId: string,
  ): Promise<VideoRoomSeatRequest | null> {
    return this.prisma.videoRoomSeatRequest.findFirst({
      where: { roomId, userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Resolve a request (accept/reject/cancel/expire). VR-8 adds the optional
   * `opts` for failure bookkeeping — `lastError` and an `attemptCount` bump —
   * so retry can be bounded without a second write.
   *
   * I6 — when `opts.expectedFrom` is given, the write is a compare-and-swap
   * (`updateMany({ where: { id, status: expectedFrom } })`) rather than an
   * unconditional `update`: if the row has already moved (another actor got
   * there first), `count` comes back 0 and this returns `null` instead of
   * clobbering whatever that actor wrote. `updateMany` can't return the row
   * itself, so a successful CAS re-reads it to keep the "returns the updated
   * entity" contract callers (e.g. `acknowledge`) rely on. Omitting
   * `expectedFrom` behaves exactly as before — every existing call site keeps
   * working unchanged.
   */
  async setRequestStatus(
    id: string,
    status: VideoRoomSeatRequestStatus,
    actorId: string,
    resolvedBy?: string | null,
    opts?: Omit<SetRequestStatusOptions, 'expectedFrom'>,
  ): Promise<VideoRoomSeatRequest>;
  async setRequestStatus(
    id: string,
    status: VideoRoomSeatRequestStatus,
    actorId: string,
    resolvedBy: string | null | undefined,
    opts: SetRequestStatusOptions & { expectedFrom: VideoRoomSeatRequestStatus },
  ): Promise<VideoRoomSeatRequest | null>;
  async setRequestStatus(
    id: string,
    status: VideoRoomSeatRequestStatus,
    actorId: string,
    resolvedBy?: string | null,
    opts?: SetRequestStatusOptions,
  ): Promise<VideoRoomSeatRequest | null> {
    const data: Prisma.VideoRoomSeatRequestUpdateManyMutationInput = {
      status,
      resolvedBy: resolvedBy ?? null,
      resolvedAt: new Date(),
      ...(opts?.lastError !== undefined ? { lastError: opts.lastError } : {}),
      ...(opts?.bumpAttempt ? { attemptCount: { increment: 1 } } : {}),
      ...auditUpdate(actorId),
    };

    if (opts?.expectedFrom === undefined) {
      return this.prisma.videoRoomSeatRequest.update({ where: { id }, data });
    }

    const { count } = await this.prisma.videoRoomSeatRequest.updateMany({
      where: { id, status: opts.expectedFrom },
      data,
    });
    if (count === 0) return null;
    return this.prisma.videoRoomSeatRequest.findUniqueOrThrow({ where: { id } });
  }

  /** Bulk-expire stale PENDING requests past their `expiresAt`. Returns the count. */
  async expireStaleRequests(now: Date): Promise<number> {
    const { count } = await this.prisma.videoRoomSeatRequest.updateMany({
      where: { status: VideoRoomSeatRequestStatus.PENDING, expiresAt: { lt: now } },
      data: { status: VideoRoomSeatRequestStatus.EXPIRED },
    });
    return count;
  }

  /**
   * VR-8 — expired PENDING requests, bounded, oldest first. The monitor walks
   * these one at a time so each expiry can publish its own event; the bulk
   * `expireStaleRequests` stays as the fallback for oversized batches.
   */
  async listExpiredRequests(now: Date, limit: number): Promise<VideoRoomSeatRequest[]> {
    return this.prisma.videoRoomSeatRequest.findMany({
      where: { status: VideoRoomSeatRequestStatus.PENDING, expiresAt: { lt: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
  }

  /** VR-8 — change only the preferred seat on a still-PENDING request. */
  async updateRequestSeatIndex(
    id: string,
    seatIndex: number | null,
    actorId: string,
  ): Promise<VideoRoomSeatRequest> {
    return this.prisma.videoRoomSeatRequest.update({
      where: { id },
      data: { seatIndex, ...auditUpdate(actorId) },
    });
  }

  /**
   * VR-8 — revive a request to PENDING with a fresh TTL. `createdAt` is
   * deliberately NOT touched: the queue score is derived from it, so a restored
   * request re-enters at exactly its former position.
   */
  async restoreRequest(
    id: string,
    actorId: string,
    expiresAt: Date,
  ): Promise<VideoRoomSeatRequest> {
    return this.prisma.videoRoomSeatRequest.update({
      where: { id },
      data: {
        status: VideoRoomSeatRequestStatus.PENDING,
        resolvedAt: null,
        resolvedBy: null,
        lastError: null,
        expiresAt,
        ...auditUpdate(actorId),
      },
    });
  }

  // ---- Invitations ----

  async createInvitation(
    input: CreateInvitationInput,
    actorId: string,
  ): Promise<VideoRoomInvitation> {
    return this.prisma.videoRoomInvitation.create({
      data: {
        roomId: input.roomId,
        inviterId: input.inviterId,
        inviteeUserId: input.inviteeUserId,
        type: input.type ?? VideoRoomInvitationType.SEAT,
        seatIndex: input.seatIndex ?? null,
        expiresAt: input.expiresAt,
        ...auditCreate(actorId),
      },
    });
  }

  /**
   * Outstanding (PENDING or DELIVERED) invitations in a room. VR-8 — DELIVERED
   * counts as outstanding too, so an acknowledged invitation still surfaces here
   * (the duplicate-invite guard) and in `listInvitations`. `inviteeUserId` stays
   * optional: `invite`'s duplicate check passes one, `listInvitations` omits it.
   */
  async listPendingInvitations(
    roomId: string,
    inviteeUserId?: string,
  ): Promise<VideoRoomInvitation[]> {
    return this.prisma.videoRoomInvitation.findMany({
      where: {
        roomId,
        ...(inviteeUserId ? { inviteeUserId } : {}),
        status: {
          in: [VideoRoomInvitationStatus.PENDING, VideoRoomInvitationStatus.DELIVERED],
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Resolve an invitation (accept/reject/cancel/expire). VR-8 adds `opts` for
   * the DELIVERED acknowledgement stamp and for failure/retry bookkeeping.
   *
   * I6 — same compare-and-swap contract as `setRequestStatus`: an
   * `opts.expectedFrom` turns this into a conditional `updateMany`, returning
   * `null` when the row was no longer in that status (lost the race) instead
   * of overwriting whatever another actor already wrote. Omitted →
   * unconditional `update`, unchanged.
   */
  async setInvitationStatus(
    id: string,
    status: VideoRoomInvitationStatus,
    actorId: string,
    opts?: Omit<SetInvitationStatusOptions, 'expectedFrom'>,
  ): Promise<VideoRoomInvitation>;
  async setInvitationStatus(
    id: string,
    status: VideoRoomInvitationStatus,
    actorId: string,
    opts: SetInvitationStatusOptions & { expectedFrom: VideoRoomInvitationStatus },
  ): Promise<VideoRoomInvitation | null>;
  async setInvitationStatus(
    id: string,
    status: VideoRoomInvitationStatus,
    actorId: string,
    opts?: SetInvitationStatusOptions,
  ): Promise<VideoRoomInvitation | null> {
    const data: Prisma.VideoRoomInvitationUpdateManyMutationInput = {
      status,
      resolvedAt: new Date(),
      ...(opts?.deliveredAt !== undefined ? { deliveredAt: opts.deliveredAt } : {}),
      ...(opts?.lastError !== undefined ? { lastError: opts.lastError } : {}),
      ...(opts?.bumpAttempt ? { attemptCount: { increment: 1 } } : {}),
      ...auditUpdate(actorId),
    };

    if (opts?.expectedFrom === undefined) {
      return this.prisma.videoRoomInvitation.update({ where: { id }, data });
    }

    const { count } = await this.prisma.videoRoomInvitation.updateMany({
      where: { id, status: opts.expectedFrom },
      data,
    });
    if (count === 0) return null;
    return this.prisma.videoRoomInvitation.findUniqueOrThrow({ where: { id } });
  }

  /** RESERVED seats across rooms — the seat monitor reconciles these against their
   * (TTL-expiring) Redis holds. Bounded by `limit`; reserved seats are few. */
  listReservedSeats(limit: number): Promise<VideoRoomSeat[]> {
    return this.prisma.videoRoomSeat.findMany({
      where: { seatStatus: VideoRoomSeatStatus.RESERVED },
      take: limit,
    });
  }

  /** Bulk-expire stale PENDING invitations past their `expiresAt`. Returns the count. */
  async expireStaleInvitations(now: Date): Promise<number> {
    const { count } = await this.prisma.videoRoomInvitation.updateMany({
      where: { status: VideoRoomInvitationStatus.PENDING, expiresAt: { lt: now } },
      data: { status: VideoRoomInvitationStatus.EXPIRED },
    });
    return count;
  }

  /** VR-8 — expired invitations (PENDING *or* DELIVERED), bounded, oldest first. */
  async listExpiredInvitations(now: Date, limit: number): Promise<VideoRoomInvitation[]> {
    return this.prisma.videoRoomInvitation.findMany({
      where: {
        status: {
          in: [VideoRoomInvitationStatus.PENDING, VideoRoomInvitationStatus.DELIVERED],
        },
        expiresAt: { lt: now },
      },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
  }

  // ---- Layout (VideoRoomSettings seat counts) ----

  /** The room's configured seat counts (platform defaults when settings are absent). */
  async getSeatLayout(roomId: string): Promise<{ hostSeatCount: number; guestSeatCount: number }> {
    const settings = await this.prisma.videoRoomSettings.findUnique({ where: { roomId } });
    return {
      hostSeatCount: settings?.hostSeatCount ?? VIDEO_ROOM_DEFAULT_HOST_SEATS,
      guestSeatCount: settings?.guestSeatCount ?? VIDEO_ROOM_DEFAULT_GUEST_SEATS,
    };
  }

  /** Persist a reconfigured layout onto the room's settings row. */
  async setSeatLayout(
    roomId: string,
    hostSeatCount: number,
    guestSeatCount: number,
    actorId: string,
  ): Promise<void> {
    await this.prisma.videoRoomSettings.update({
      where: { roomId },
      data: { hostSeatCount, guestSeatCount, ...auditUpdate(actorId) },
    });
  }

  /** Delete seat rows at or beyond `minIndex` (layout shrink). Returns the count. */
  async deleteSeatsFrom(roomId: string, minIndex: number): Promise<number> {
    const { count } = await this.prisma.videoRoomSeat.deleteMany({
      where: { roomId, seatIndex: { gte: minIndex } },
    });
    return count;
  }

  // ---- By-id lookups + bulk resolve (request/invitation workflows) ----

  findRequestById(id: string): Promise<VideoRoomSeatRequest | null> {
    return this.prisma.videoRoomSeatRequest.findUnique({ where: { id } });
  }

  findInvitationById(id: string): Promise<VideoRoomInvitation | null> {
    return this.prisma.videoRoomInvitation.findUnique({ where: { id } });
  }

  /** All PENDING invitations in a room (stage overlays + expiry sweep). */
  listPendingInvitationsForRoom(roomId: string): Promise<VideoRoomInvitation[]> {
    return this.prisma.videoRoomInvitation.findMany({
      where: { roomId, status: VideoRoomInvitationStatus.PENDING },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Resolve every PENDING request a user holds in a room (e.g. once they are seated). */
  async resolveAllPendingRequestsForUser(
    roomId: string,
    userId: string,
    status: VideoRoomSeatRequestStatus,
    actorId: string,
  ): Promise<void> {
    await this.prisma.videoRoomSeatRequest.updateMany({
      where: { roomId, userId, status: VideoRoomSeatRequestStatus.PENDING },
      data: { status, resolvedBy: actorId, resolvedAt: new Date(), ...auditUpdate(actorId) },
    });
  }

  /** Convenience for tests/services: does a seat currently show as occupied? */
  isSeatOccupied(seat: VideoRoomSeat): boolean {
    return seat.seatStatus === VideoRoomSeatStatus.OCCUPIED && seat.occupantUserId != null;
  }

  // ---- Room invitations (VR-15) ----

  /** An outstanding (PENDING/DELIVERED) ROOM invitation for this invitee, if any. */
  async findActiveRoomInvitation(
    roomId: string,
    inviteeUserId: string,
  ): Promise<VideoRoomInvitation | null> {
    return this.prisma.videoRoomInvitation.findFirst({
      where: {
        roomId,
        inviteeUserId,
        type: VideoRoomInvitationType.ROOM,
        status: { in: [VideoRoomInvitationStatus.PENDING, VideoRoomInvitationStatus.DELIVERED] },
      },
    });
  }

  /** True if the user holds a still-valid ROOM invitation (grants private-room access). */
  async hasActiveRoomInvitation(roomId: string, userId: string): Promise<boolean> {
    const row = await this.prisma.videoRoomInvitation.findFirst({
      where: {
        roomId,
        inviteeUserId: userId,
        type: VideoRoomInvitationType.ROOM,
        status: {
          in: [
            VideoRoomInvitationStatus.PENDING,
            VideoRoomInvitationStatus.DELIVERED,
            VideoRoomInvitationStatus.ACCEPTED,
          ],
        },
        // Expiry-bound the grant: an ACCEPTED invitation is never swept to
        // EXPIRED, so without this an accepted invite would bypass the room
        // password indefinitely (surviving leave/rejoin and even a password
        // rotation). The bypass now lasts only within the invitation's TTL.
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    return row !== null;
  }
}
