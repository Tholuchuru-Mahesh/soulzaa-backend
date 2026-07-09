import { Injectable } from '@nestjs/common';
import {
  Prisma,
  RoomMemberRole,
  RoomRole,
  RoomSeat,
  RoomSettings,
  SeatHistoryAction,
  SeatInvitation,
  SeatInvitationStatus,
  SeatQueueEntry,
  SeatRequest,
  SeatRequestStatus,
  SeatType,
} from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { CacheService } from 'src/infra/redis/cache.service';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { buildSeatLayout, roomStageCacheKey } from '../constants/audio-room.constants';

/** A cached stage snapshot: seats + ordered queue + the seat-relevant settings. */
export interface StageSnapshot {
  seats: Array<{
    seatIndex: number;
    seatType: SeatType;
    occupantUserId: string | null;
    isLocked: boolean;
    isMuted: boolean;
  }>;
  queue: Array<{ userId: string; position: number }>;
  settings: {
    speakerSeatCount: number;
    premiumAdminSeatCount: number;
    isRoomMuted: boolean;
    requireApprovalForSeat: boolean;
  };
}

/**
 * Data layer for the AR-1 role & seat system: Postgres (room_roles, room_seats,
 * seat_requests, seat_invitations, seat_queue, seat_history) plus the Redis
 * stage-snapshot cache. Pure persistence — business rules, permission checks and
 * concurrency locks live in the services. The DB is authoritative for seat and
 * queue state; the Redis snapshot is a read-through cache invalidated on change.
 */
@Injectable()
export class AudioRoomSeatsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  // ---- Room roles (authoritative elevated grants) ----

  getRole(roomId: string, userId: string): Promise<RoomRole | null> {
    return this.prisma.roomRole.findUnique({ where: { roomId_userId: { roomId, userId } } });
  }

  /** User ids holding an elevated grant (owner/admin/premium-admin) in a room. */
  async listElevatedMemberIds(roomId: string): Promise<string[]> {
    const rows = await this.prisma.roomRole.findMany({
      where: { roomId },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  async upsertRole(
    roomId: string,
    userId: string,
    role: RoomMemberRole,
    grantedBy: string,
  ): Promise<void> {
    await this.prisma.roomRole.upsert({
      where: { roomId_userId: { roomId, userId } },
      create: { roomId, userId, role, grantedBy, ...auditCreate(grantedBy) },
      update: { role, grantedBy, ...auditUpdate(grantedBy) },
    });
  }

  async deleteRole(roomId: string, userId: string): Promise<void> {
    await this.prisma.roomRole.deleteMany({ where: { roomId, userId } });
  }

  // ---- Seats ----

  listSeats(roomId: string): Promise<RoomSeat[]> {
    return this.prisma.roomSeat.findMany({ where: { roomId }, orderBy: { seatIndex: 'asc' } });
  }

  getSeatByIndex(roomId: string, seatIndex: number): Promise<RoomSeat | null> {
    return this.prisma.roomSeat.findUnique({ where: { roomId_seatIndex: { roomId, seatIndex } } });
  }

  getSeatByOccupant(roomId: string, userId: string): Promise<RoomSeat | null> {
    return this.prisma.roomSeat.findFirst({ where: { roomId, occupantUserId: userId } });
  }

  async setOccupant(
    roomId: string,
    seatIndex: number,
    occupantUserId: string | null,
    actorId: string,
  ): Promise<void> {
    await this.prisma.roomSeat.update({
      where: { roomId_seatIndex: { roomId, seatIndex } },
      data: { occupantUserId, ...auditUpdate(actorId) },
    });
  }

  async setSeatLocked(
    roomId: string,
    seatIndex: number,
    isLocked: boolean,
    actorId: string,
  ): Promise<void> {
    await this.prisma.roomSeat.update({
      where: { roomId_seatIndex: { roomId, seatIndex } },
      data: { isLocked, ...auditUpdate(actorId) },
    });
  }

  async setSeatMuted(
    roomId: string,
    seatIndex: number,
    isMuted: boolean,
    actorId: string,
  ): Promise<void> {
    await this.prisma.roomSeat.update({
      where: { roomId_seatIndex: { roomId, seatIndex } },
      data: { isMuted, ...auditUpdate(actorId) },
    });
  }

  /** Mute/unmute every occupied speaker + premium seat (room-mute). */
  async setSpeakerSeatsMuted(roomId: string, isMuted: boolean, actorId: string): Promise<void> {
    await this.prisma.roomSeat.updateMany({
      where: { roomId, seatType: { in: [SeatType.SPEAKER, SeatType.PREMIUM_ADMIN] } },
      data: { isMuted, ...auditUpdate(actorId) },
    });
  }

  /**
   * Reconfigure the stage layout: drop seats beyond the new counts (returning
   * their occupants), add new empty seats, and preserve the owner seat + any
   * still-in-range occupied seats. Runs in one transaction. Returns the user ids
   * that were displaced (so the service can advance the queue / notify them).
   */
  async reconfigureLayoutTx(
    roomId: string,
    premiumAdminSeatCount: number,
    speakerSeatCount: number,
    actorId: string,
  ): Promise<{ displaced: string[] }> {
    const layout = buildSeatLayout(premiumAdminSeatCount, speakerSeatCount);
    const keepIndexes = new Set(layout.map((s) => s.seatIndex));
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.roomSeat.findMany({ where: { roomId } });
      const displaced: string[] = [];
      // Remove seats no longer in the layout (owner seat index 0 is always kept).
      for (const seat of current) {
        if (!keepIndexes.has(seat.seatIndex)) {
          if (seat.occupantUserId) displaced.push(seat.occupantUserId);
          await tx.roomSeat.delete({ where: { id: seat.id } });
        }
      }
      const existingIndexes = new Set(current.map((s) => s.seatIndex));
      // Add newly introduced seats.
      for (const slot of layout) {
        if (!existingIndexes.has(slot.seatIndex)) {
          await tx.roomSeat.create({
            data: {
              roomId,
              seatIndex: slot.seatIndex,
              seatType: slot.seatType,
              ...auditCreate(actorId),
            },
          });
        } else if (slot.seatIndex !== 0) {
          // Keep type in sync (e.g. a former premium seat becoming a speaker seat).
          await tx.roomSeat.update({
            where: { roomId_seatIndex: { roomId, seatIndex: slot.seatIndex } },
            data: { seatType: slot.seatType, ...auditUpdate(actorId) },
          });
        }
      }
      await tx.roomSettings.update({
        where: { roomId },
        data: { premiumAdminSeatCount, speakerSeatCount },
      });
      return { displaced };
    });
  }

  // ---- Seat requests ----

  createRequest(
    roomId: string,
    userId: string,
    seatIndex: number | null,
    actorId: string,
  ): Promise<SeatRequest> {
    return this.prisma.seatRequest.create({
      data: { roomId, userId, seatIndex, ...auditCreate(actorId) },
    });
  }

  findPendingRequestByUser(roomId: string, userId: string): Promise<SeatRequest | null> {
    return this.prisma.seatRequest.findFirst({
      where: { roomId, userId, status: SeatRequestStatus.PENDING },
    });
  }

  getRequest(requestId: string): Promise<SeatRequest | null> {
    return this.prisma.seatRequest.findUnique({ where: { id: requestId } });
  }

  listPendingRequests(roomId: string): Promise<SeatRequest[]> {
    return this.prisma.seatRequest.findMany({
      where: { roomId, status: SeatRequestStatus.PENDING },
      orderBy: { createdAt: 'asc' },
    });
  }

  async resolveRequest(
    requestId: string,
    status: SeatRequestStatus,
    resolvedBy: string,
  ): Promise<void> {
    await this.prisma.seatRequest.update({
      where: { id: requestId },
      data: { status, resolvedBy, resolvedAt: new Date(), ...auditUpdate(resolvedBy) },
    });
  }

  // ---- Seat invitations ----

  createInvitation(input: {
    roomId: string;
    inviterId: string;
    inviteeUserId: string;
    seatIndex: number | null;
    expiresAt: Date;
  }): Promise<SeatInvitation> {
    return this.prisma.seatInvitation.create({
      data: {
        roomId: input.roomId,
        inviterId: input.inviterId,
        inviteeUserId: input.inviteeUserId,
        seatIndex: input.seatIndex,
        expiresAt: input.expiresAt,
        ...auditCreate(input.inviterId),
      },
    });
  }

  getInvitation(id: string): Promise<SeatInvitation | null> {
    return this.prisma.seatInvitation.findUnique({ where: { id } });
  }

  async resolveInvitation(
    id: string,
    status: SeatInvitationStatus,
    actorId: string,
  ): Promise<void> {
    await this.prisma.seatInvitation.update({
      where: { id },
      data: { status, resolvedAt: new Date(), ...auditUpdate(actorId) },
    });
  }

  // ---- Seat queue (DB-authoritative, ordered by position) ----

  listQueue(roomId: string): Promise<SeatQueueEntry[]> {
    return this.prisma.seatQueueEntry.findMany({
      where: { roomId },
      orderBy: { position: 'asc' },
    });
  }

  queueEntry(roomId: string, userId: string): Promise<SeatQueueEntry | null> {
    return this.prisma.seatQueueEntry.findUnique({ where: { roomId_userId: { roomId, userId } } });
  }

  /** Append to the back of the queue. Position = (current max) + 1. */
  async enqueue(roomId: string, userId: string, requestId: string | null): Promise<SeatQueueEntry> {
    const last = await this.prisma.seatQueueEntry.findFirst({
      where: { roomId },
      orderBy: { position: 'desc' },
    });
    const position = (last?.position ?? 0) + 1;
    return this.prisma.seatQueueEntry.upsert({
      where: { roomId_userId: { roomId, userId } },
      create: { roomId, userId, position, requestId },
      update: {}, // already queued → keep original position
    });
  }

  async dequeue(roomId: string, userId: string): Promise<void> {
    await this.prisma.seatQueueEntry.deleteMany({ where: { roomId, userId } });
  }

  /** Remove and return the front (lowest position) queue entry, if any. */
  async popFront(roomId: string): Promise<SeatQueueEntry | null> {
    const front = await this.prisma.seatQueueEntry.findFirst({
      where: { roomId },
      orderBy: { position: 'asc' },
    });
    if (!front) return null;
    await this.prisma.seatQueueEntry.delete({ where: { id: front.id } });
    return front;
  }

  async clearQueue(roomId: string): Promise<void> {
    await this.prisma.seatQueueEntry.deleteMany({ where: { roomId } });
  }

  /** Vacate every seat and clear the queue (on room end/delete). */
  async clearStageTx(roomId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.roomSeat.updateMany({
        where: { roomId, occupantUserId: { not: null } },
        data: { occupantUserId: null },
      }),
      this.prisma.seatQueueEntry.deleteMany({ where: { roomId } }),
    ]);
  }

  // ---- Immutable seat/role audit ----

  async appendSeatHistory(input: {
    roomId: string;
    actorId: string | null;
    subjectUserId?: string | null;
    action: SeatHistoryAction;
    seatIndex?: number | null;
    metadata?: Prisma.InputJsonValue;
  }): Promise<void> {
    await this.prisma.seatHistory.create({
      data: {
        roomId: input.roomId,
        actorId: input.actorId,
        subjectUserId: input.subjectUserId ?? null,
        action: input.action,
        seatIndex: input.seatIndex ?? null,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    });
  }

  // ---- Settings (seat-relevant) ----

  getSettings(roomId: string): Promise<RoomSettings | null> {
    return this.prisma.roomSettings.findUnique({ where: { roomId } });
  }

  async setRoomMuted(roomId: string, isRoomMuted: boolean): Promise<void> {
    await this.prisma.roomSettings.update({ where: { roomId }, data: { isRoomMuted } });
  }

  async setRequireApprovalForSeat(roomId: string, requireApprovalForSeat: boolean): Promise<void> {
    await this.prisma.roomSettings.update({ where: { roomId }, data: { requireApprovalForSeat } });
  }

  // ---- Redis stage snapshot cache ----

  getCachedStage(roomId: string): Promise<StageSnapshot | null> {
    return this.cache.get<StageSnapshot>(roomStageCacheKey(roomId));
  }

  async setCachedStage(roomId: string, snapshot: StageSnapshot, ttlSeconds: number): Promise<void> {
    await this.cache.set(roomStageCacheKey(roomId), snapshot, ttlSeconds);
  }

  async invalidateStage(roomId: string): Promise<void> {
    await this.cache.del(roomStageCacheKey(roomId));
  }
}
