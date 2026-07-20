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

  /** Resolve a request (accept/reject/cancel/expire). */
  async setRequestStatus(
    id: string,
    status: VideoRoomSeatRequestStatus,
    actorId: string,
    resolvedBy?: string | null,
  ): Promise<VideoRoomSeatRequest> {
    return this.prisma.videoRoomSeatRequest.update({
      where: { id },
      data: {
        status,
        resolvedBy: resolvedBy ?? null,
        resolvedAt: new Date(),
        ...auditUpdate(actorId),
      },
    });
  }

  /** Bulk-expire stale PENDING requests past their `expiresAt`. Returns the count. */
  async expireStaleRequests(now: Date): Promise<number> {
    const { count } = await this.prisma.videoRoomSeatRequest.updateMany({
      where: { status: VideoRoomSeatRequestStatus.PENDING, expiresAt: { lt: now } },
      data: { status: VideoRoomSeatRequestStatus.EXPIRED },
    });
    return count;
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

  /** An invitee's current PENDING invitations in a room. */
  async listPendingInvitations(
    roomId: string,
    inviteeUserId: string,
  ): Promise<VideoRoomInvitation[]> {
    return this.prisma.videoRoomInvitation.findMany({
      where: { roomId, inviteeUserId, status: VideoRoomInvitationStatus.PENDING },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Resolve an invitation (accept/reject/cancel/expire). */
  async setInvitationStatus(
    id: string,
    status: VideoRoomInvitationStatus,
    actorId: string,
  ): Promise<VideoRoomInvitation> {
    return this.prisma.videoRoomInvitation.update({
      where: { id },
      data: { status, resolvedAt: new Date(), ...auditUpdate(actorId) },
    });
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
}
