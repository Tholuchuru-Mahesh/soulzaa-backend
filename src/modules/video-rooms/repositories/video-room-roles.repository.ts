import { Injectable } from '@nestjs/common';
import { VideoRoomMemberRole, VideoRoomRole } from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** Grant/replace an elevated in-room role for a user. */
export interface GrantRoleInput {
  roomId: string;
  userId: string;
  role: VideoRoomMemberRole;
  grantedBy: string;
  expiresAt?: Date | null;
}

/**
 * Persistence for `video_room_roles` — the authoritative elevated-role grants
 * (OWNER / ADMIN / MODERATOR) inside a video room. One grant per (room,user):
 * granting again upserts. Pure persistence — the effective-role resolution and
 * permission checks live in the (later) permission service. No cross-domain FK:
 * users/rooms are referenced by id.
 */
@Injectable()
export class VideoRoomRolesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Upsert a user's elevated grant (one per room+user). */
  async grant(input: GrantRoleInput): Promise<VideoRoomRole> {
    return this.prisma.videoRoomRole.upsert({
      where: { roomId_userId: { roomId: input.roomId, userId: input.userId } },
      create: {
        roomId: input.roomId,
        userId: input.userId,
        role: input.role,
        grantedBy: input.grantedBy,
        expiresAt: input.expiresAt ?? null,
        ...auditCreate(input.grantedBy),
      },
      update: {
        role: input.role,
        grantedBy: input.grantedBy,
        expiresAt: input.expiresAt ?? null,
        ...auditUpdate(input.grantedBy),
      },
    });
  }

  /**
   * A user's grant row regardless of expiry. Retained for administrative reads
   * and history; **authorization must use `findActive`** — this one will happily
   * return a grant that lapsed months ago.
   */
  async find(roomId: string, userId: string): Promise<VideoRoomRole | null> {
    return this.prisma.videoRoomRole.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
  }

  /** All grant rows in a room regardless of expiry. See `listActiveByRoom`. */
  async listByRoom(roomId: string): Promise<VideoRoomRole[]> {
    return this.prisma.videoRoomRole.findMany({
      where: { roomId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * A user's *active* grant — the expiry-aware read every permission decision
   * must use (VR-7). `expiresAt` has been persisted since VR-1 but nothing read
   * it, so a temporary ADMIN kept full powers forever. Filtering here makes
   * expiry a correctness property of the read itself: a lapsed grant resolves to
   * null the moment it lapses, whether or not the sweeper has run.
   */
  async findActive(
    roomId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<VideoRoomRole | null> {
    return this.prisma.videoRoomRole.findFirst({
      where: { roomId, userId, ...VideoRoomRolesRepository.notExpired(now) },
    });
  }

  /** All active elevated grants in a room (role listing, effective-role reporting). */
  async listActiveByRoom(roomId: string, now: Date = new Date()): Promise<VideoRoomRole[]> {
    return this.prisma.videoRoomRole.findMany({
      where: { roomId, ...VideoRoomRolesRepository.notExpired(now) },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** How many active grants of `role` a room holds (enforces the PRD 25-admin cap). */
  async countByRole(
    roomId: string,
    role: VideoRoomMemberRole,
    now: Date = new Date(),
  ): Promise<number> {
    return this.prisma.videoRoomRole.count({
      where: { roomId, role, ...VideoRoomRolesRepository.notExpired(now) },
    });
  }

  /** Grants whose expiry has passed — the sweeper's work queue, oldest first. */
  async listExpired(now: Date, take: number): Promise<VideoRoomRole[]> {
    return this.prisma.videoRoomRole.findMany({
      where: { expiresAt: { not: null, lte: now } },
      orderBy: { expiresAt: 'asc' },
      take,
    });
  }

  /** Hard-delete grants by id (sweeper cleanup). Returns rows removed. */
  async deleteByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.prisma.videoRoomRole.deleteMany({
      where: { id: { in: ids } },
    });
    return count;
  }

  /** "Permanent, or not yet expired" — the shared active-grant predicate. */
  private static notExpired(now: Date) {
    return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  }

  /** Revoke a user's grant. Returns how many rows were removed (0 or 1). */
  async revoke(roomId: string, userId: string): Promise<number> {
    const { count } = await this.prisma.videoRoomRole.deleteMany({
      where: { roomId, userId },
    });
    return count;
  }
}
