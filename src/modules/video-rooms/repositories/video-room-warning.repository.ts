import { Injectable } from '@nestjs/common';
import { Prisma, VideoRoomWarning } from '@prisma/client';
import { auditCreate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface CreateVideoRoomWarningInput {
  roomId: string;
  userId: string;
  moderatorId: string;
  reason: string;
  metadata?: Prisma.InputJsonValue;
}

export interface ListVideoRoomWarningsParams {
  skip: number;
  take: number;
  userId?: string;
}

/**
 * Persistence for `video_room_warnings` — a moderator-issued warning, logged
 * independently of the append-only `video_room_moderation_actions` audit so
 * warnings can be queried (and later surfaced to the user) on their own. Pure
 * persistence — the service still calls `moderationRepo.appendAction(WARN)`
 * for the immutable audit trail.
 */
@Injectable()
export class VideoRoomWarningRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateVideoRoomWarningInput): Promise<VideoRoomWarning> {
    return this.prisma.videoRoomWarning.create({
      data: {
        roomId: input.roomId,
        userId: input.userId,
        moderatorId: input.moderatorId,
        reason: input.reason,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        ...auditCreate(input.moderatorId),
      },
    });
  }

  list(roomId: string, params: ListVideoRoomWarningsParams): Promise<[VideoRoomWarning[], number]> {
    const where: Prisma.VideoRoomWarningWhereInput = {
      roomId,
      ...(params.userId ? { userId: params.userId } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.videoRoomWarning.findMany({
        where,
        skip: params.skip,
        take: params.take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.videoRoomWarning.count({ where }),
    ]);
  }

  count(roomId: string, userId: string): Promise<number> {
    return this.prisma.videoRoomWarning.count({ where: { roomId, userId } });
  }
}
