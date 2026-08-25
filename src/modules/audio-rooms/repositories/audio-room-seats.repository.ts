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
  queue: Array<{ userId: string; position: number; requestId?: string | null }>;
  settings: {
    speakerSeatCount: number;
    premiumAdminSeatCount: number;
    isRoomMuted: boolean;
    requireApprovalForSeat: boolean;
    metadata?: Record<string, unknown> | null;
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

  /** Total number of active admins (ADMIN or PREMIUM_ADMIN) in a room (maximum 25 allowed). */
  async countAdmins(roomId: string): Promise<number> {
    return this.prisma.roomRole.count({
      where: {
        roomId,
        role: { in: [RoomMemberRole.ADMIN, RoomMemberRole.PREMIUM_ADMIN] },
      },
    });
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

  /**
   * Broad Mute, as one atomic write: the room flag and the per-seat fan-out
   * both land or neither does. Split across two statements they can diverge —
   * seats left muted under a flag that reads false strand every speaker with
   * `canToggleMic` false and no way back, since the client derives the toggle
   * from the flag but the mute lives on the seat. The owner seat is not in the
   * fan-out; the host is exempt from Broad Mute everywhere in the module.
   */
  async setRoomMutedTx(roomId: string, isRoomMuted: boolean, actorId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.roomSettings.update({ where: { roomId }, data: { isRoomMuted } }),
      this.prisma.roomSeat.updateMany({
        where: { roomId, seatType: { in: [SeatType.SPEAKER, SeatType.PREMIUM_ADMIN] } },
        data: { isMuted: isRoomMuted, ...auditUpdate(actorId) },
      }),
    ]);
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
    type: string,
    actorId: string,
  ): Promise<SeatRequest> {
    return this.prisma.seatRequest.create({
      data: { roomId, userId, seatIndex, type, ...auditCreate(actorId) },
    });
  }

  findPendingRequestByUser(
    roomId: string,
    userId: string,
    type?: string,
  ): Promise<SeatRequest | null> {
    return this.prisma.seatRequest.findFirst({
      where: {
        roomId,
        userId,
        status: SeatRequestStatus.PENDING,
        ...(type ? { type } : {}),
      },
    });
  }

  findPendingRequestsByUser(roomId: string, userId: string, type?: string): Promise<SeatRequest[]> {
    return this.prisma.seatRequest.findMany({
      where: {
        roomId,
        userId,
        status: SeatRequestStatus.PENDING,
        ...(type ? { type } : {}),
      },
      orderBy: { createdAt: 'asc' },
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

  async resolveAllPendingRequestsForUser(
    roomId: string,
    userId: string,
    status: SeatRequestStatus,
    resolvedBy: string,
  ): Promise<void> {
    await this.prisma.seatRequest.updateMany({
      where: {
        roomId,
        userId,
        status: SeatRequestStatus.PENDING,
      },
      data: {
        status,
        resolvedBy,
        resolvedAt: new Date(),
        updatedBy: resolvedBy,
        updatedAt: new Date(),
      },
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

  async clearPendingRequests(roomId: string): Promise<void> {
    await this.prisma.seatRequest.updateMany({
      where: { roomId, status: SeatRequestStatus.PENDING },
      data: { status: SeatRequestStatus.CANCELLED, resolvedAt: new Date() },
    });
  }

  /**
   * Drops every session-scoped participant state for a room in one transaction —
   * the reset that makes each live a genuinely fresh event.
   *
   * A room row is permanent and one-per-owner, so the same row is reused for every
   * live. Without this, an ADMIN promoted in one session was still an ADMIN in the
   * next: `RoomPermissionService.getEffectiveRole` resolves the `room_roles` grant
   * *before* it ever looks at seat occupancy, so clearing the stage alone changed
   * nothing for elevated users.
   *
   * Two kinds of grant deliberately survive:
   *  - OWNER, which is a property of the room, not of a session.
   *  - PREMIUM_ADMIN backed by an unexpired {@link PremiumAdminSeat}, which is a
   *    time-boxed entitlement bought with gold and measured in days. Wiping it
   *    because the owner ended a live would burn purchased value. A paid holder who
   *    was *also* promoted to ADMIN is re-pinned down to the PREMIUM_ADMIN they
   *    actually paid for rather than keeping the free promotion.
   *
   * Moderation penalties (`room_bans`, `room_mutes`) are NOT session state and are
   * left untouched — they carry their own expiry, and clearing them here would let
   * an offender wipe a ban by getting the room restarted.
   */
  async clearSessionStateTx(roomId: string): Promise<void> {
    const now = new Date();

    await this.prisma.$transaction([
      // Stage: free every seat and drop the admin lock/mute flags with it, so the
      // next session does not open with seats silenced or reserved by the last one.
      this.prisma.roomSeat.updateMany({
        where: { roomId },
        data: { occupantUserId: null, isMuted: false, isLocked: false },
      }),
      this.prisma.seatQueueEntry.deleteMany({ where: { roomId } }),
      this.prisma.seatRequest.updateMany({
        where: { roomId, status: SeatRequestStatus.PENDING },
        data: { status: SeatRequestStatus.CANCELLED, resolvedAt: now },
      }),
      this.prisma.seatInvitation.updateMany({
        where: { roomId, status: SeatInvitationStatus.PENDING },
        data: { status: SeatInvitationStatus.EXPIRED, resolvedAt: now },
      }),
      this.prisma.roomSettings.updateMany({
        where: { roomId },
        data: { isRoomMuted: false },
      }),
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

  async isRoomMuted(roomId: string): Promise<boolean> {
    const settings = await this.getSettings(roomId);
    return settings?.isRoomMuted ?? false;
  }

  // Broad Mute is written only through `setRoomMutedTx` — the room flag and the
  // per-seat fan-out are one operation. Standalone setters for either half used
  // to exist here; they are gone so the two cannot drift apart again.

  async setRequireApprovalForSeat(roomId: string, requireApprovalForSeat: boolean): Promise<void> {
    await this.prisma.roomSettings.update({ where: { roomId }, data: { requireApprovalForSeat } });
  }

  /** Persist free-form seat layout metadata (preset slug, seatOrder, disabledSeats) */
  async setMetadata(roomId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.prisma.roomSettings.update({
      where: { roomId },
      data: { metadata: metadata as Prisma.InputJsonValue },
    });
  }

  /**
   * Bulk-set isLocked on seats. For each entry (seatIndex → locked), update the
   * row atomically. Seats not listed are not touched.
   */
  async setSeatsLocked(
    roomId: string,
    locks: Map<number, boolean>,
    actorId: string,
  ): Promise<void> {
    for (const [seatIndex, isLocked] of locks.entries()) {
      await this.prisma.roomSeat.updateMany({
        where: { roomId, seatIndex },
        data: { isLocked, ...auditUpdate(actorId) },
      });
    }
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
