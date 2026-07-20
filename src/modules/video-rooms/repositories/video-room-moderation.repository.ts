import { Injectable } from '@nestjs/common';
import {
  Prisma,
  VideoRoomBlock,
  VideoRoomModerationActionType,
  VideoRoomModerationMuteType,
  VideoRoomModerationStatus,
  VideoRoomMute,
} from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface CreateMuteInput {
  roomId: string;
  userId: string;
  moderatorId: string;
  type: VideoRoomModerationMuteType;
  reason?: string | null;
  expiresAt?: Date | null;
}

export interface CreateBlockInput {
  roomId: string;
  userId: string;
  moderatorId: string;
  reason?: string | null;
}

export interface AppendModerationActionInput {
  roomId: string;
  moderatorId: string | null;
  targetUserId: string | null;
  action: VideoRoomModerationActionType;
  reason?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Persistence for video-room moderation: `video_room_mutes`, `video_room_blocks`,
 * and the append-only `video_room_moderation_actions` audit. NO ban table — the
 * Video Room has no ban feature; a block is the durable "bar from this room until
 * lifted". "One ACTIVE mute/block per (room,user)" is enforced by the caller under
 * a lock (a partial-unique on an enum status is not expressed in Prisma). Live
 * enforcement sets are cached in Redis in later phases; these tables are the
 * durable record.
 */
@Injectable()
export class VideoRoomModerationRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Mutes ----

  async createMute(input: CreateMuteInput): Promise<VideoRoomMute> {
    return this.prisma.videoRoomMute.create({
      data: {
        roomId: input.roomId,
        userId: input.userId,
        moderatorId: input.moderatorId,
        type: input.type,
        reason: input.reason ?? null,
        expiresAt: input.expiresAt ?? null,
        ...auditCreate(input.moderatorId),
      },
    });
  }

  /** A user's current ACTIVE mute in a room, or null. */
  async findActiveMute(roomId: string, userId: string): Promise<VideoRoomMute | null> {
    return this.prisma.videoRoomMute.findFirst({
      where: { roomId, userId, status: VideoRoomModerationStatus.ACTIVE },
    });
  }

  /** Lift a mute (manual unmute). */
  async liftMute(id: string, liftedBy: string): Promise<VideoRoomMute> {
    return this.prisma.videoRoomMute.update({
      where: { id },
      data: {
        status: VideoRoomModerationStatus.LIFTED,
        liftedBy,
        liftedAt: new Date(),
        ...auditUpdate(liftedBy),
      },
    });
  }

  /** Bulk-expire ACTIVE temporary mutes past their `expiresAt`. Returns the count. */
  async expireMutes(now: Date): Promise<number> {
    const { count } = await this.prisma.videoRoomMute.updateMany({
      where: { status: VideoRoomModerationStatus.ACTIVE, expiresAt: { lt: now } },
      data: { status: VideoRoomModerationStatus.EXPIRED },
    });
    return count;
  }

  // ---- Blocks ----

  async createBlock(input: CreateBlockInput): Promise<VideoRoomBlock> {
    return this.prisma.videoRoomBlock.create({
      data: {
        roomId: input.roomId,
        userId: input.userId,
        moderatorId: input.moderatorId,
        reason: input.reason ?? null,
        ...auditCreate(input.moderatorId),
      },
    });
  }

  /** A user's current ACTIVE block in a room, or null (the join-time gate). */
  async findActiveBlock(roomId: string, userId: string): Promise<VideoRoomBlock | null> {
    return this.prisma.videoRoomBlock.findFirst({
      where: { roomId, userId, status: VideoRoomModerationStatus.ACTIVE },
    });
  }

  /** Active blocks in a room (the room's blocklist). */
  async listActiveBlocks(roomId: string): Promise<VideoRoomBlock[]> {
    return this.prisma.videoRoomBlock.findMany({
      where: { roomId, status: VideoRoomModerationStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Lift a block (restore the user). */
  async liftBlock(id: string, liftedBy: string): Promise<VideoRoomBlock> {
    return this.prisma.videoRoomBlock.update({
      where: { id },
      data: {
        status: VideoRoomModerationStatus.LIFTED,
        liftedBy,
        liftedAt: new Date(),
        ...auditUpdate(liftedBy),
      },
    });
  }

  // ---- Append-only audit ----

  async appendAction(input: AppendModerationActionInput): Promise<void> {
    await this.prisma.videoRoomModerationAction.create({
      data: {
        roomId: input.roomId,
        moderatorId: input.moderatorId,
        targetUserId: input.targetUserId,
        action: input.action,
        reason: input.reason ?? null,
        metadata: input.metadata,
      },
    });
  }

  /** Recent moderation actions in a room (compliance review). */
  async listActions(
    roomId: string,
    take: number,
  ): Promise<Prisma.VideoRoomModerationActionGetPayload<object>[]> {
    return this.prisma.videoRoomModerationAction.findMany({
      where: { roomId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }
}
