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

  /** A user's current grant in a room, or null. */
  async find(roomId: string, userId: string): Promise<VideoRoomRole | null> {
    return this.prisma.videoRoomRole.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
  }

  /** All elevated grants in a room (OWNER/ADMIN/MODERATOR). */
  async listByRoom(roomId: string): Promise<VideoRoomRole[]> {
    return this.prisma.videoRoomRole.findMany({
      where: { roomId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Revoke a user's grant. Returns how many rows were removed (0 or 1). */
  async revoke(roomId: string, userId: string): Promise<number> {
    const { count } = await this.prisma.videoRoomRole.deleteMany({
      where: { roomId, userId },
    });
    return count;
  }
}
