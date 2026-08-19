import { Injectable } from '@nestjs/common';
import { Prisma, VideoRoomStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface AdminListRoomsParams {
  skip?: number;
  take?: number;
  status?: VideoRoomStatus;
  ownerId?: string;
  isLocked?: boolean;
  search?: string;
}

@Injectable()
export class VideoRoomsAdminRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listRooms(params: AdminListRoomsParams) {
    const skip = params.skip ?? 0;
    const take = params.take ?? 20;

    const where: Prisma.VideoRoomWhereInput = {
      deletedAt: null,
      ...(params.status ? { status: params.status } : {}),
      ...(params.ownerId ? { ownerId: params.ownerId } : {}),
      ...(params.isLocked !== undefined ? { isLocked: params.isLocked } : {}),
      ...(params.search
        ? {
            name: { contains: params.search, mode: 'insensitive' as const },
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.videoRoom.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.videoRoom.count({ where }),
    ]);

    return { items, total };
  }

  async getRoomDetail(roomId: string) {
    return this.prisma.videoRoom.findFirst({
      where: { id: roomId, deletedAt: null },
    });
  }

  async getRoomGiftTransactions(roomId: string, skip: number = 0, limit: number = 20) {
    const where = {
      contextId: roomId,
      contextType: 'VIDEO_ROOM' as const,
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.giftTransaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.giftTransaction.count({ where }),
    ]);

    const giftIds = Array.from(new Set(rows.map((r) => r.giftId)));
    const giftsMap = new Map<string, any>();
    if (giftIds.length > 0) {
      const giftRows = await this.prisma.gift.findMany({
        where: { id: { in: giftIds } },
        select: { id: true, name: true, thumbnailUrl: true, displayName: true },
      });
      giftRows.forEach((g) => giftsMap.set(g.id, g));
    }

    const items = rows.map((r) => {
      const giftInfo = giftsMap.get(r.giftId);
      return {
        ...r,
        totalCoinValue: r.totalCoinValue.toString(),
        creatorEarnings: r.creatorEarnings.toString(),
        giftName: giftInfo?.displayName || giftInfo?.name || 'Gift',
        giftThumbnailUrl: giftInfo?.thumbnailUrl || null,
      };
    });

    return { items, total };
  }

  async getRoomLogs(roomId: string, skip: number = 0, limit: number = 20) {
    const where = { roomId };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.roomLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.roomLog.count({ where }),
    ]);

    return { items, total };
  }

  async createRoomLog(data: {
    roomId: string;
    action: string;
    actorId?: string;
    details?: Record<string, unknown>;
  }) {
    return this.prisma.roomLog.create({
      data: {
        roomId: data.roomId,
        action: data.action as any,
        actorId: data.actorId,
        metadata: (data.details as any) ?? undefined,
      },
    });
  }
}
