import { Injectable } from '@nestjs/common';
import { RoomLiveSession, RoomLiveSessionStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Data layer for `room_live_sessions` — one row per "went live → ended" cycle
 * of a permanent AR-0 room. Pure persistence; opened/closed by
 * `AudioRoomsService.goLive()`/`end()`, read by the creator-center module for
 * "My Live History".
 */
@Injectable()
export class LiveSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  openSession(roomId: string, ownerId: string): Promise<RoomLiveSession> {
    return this.prisma.roomLiveSession.create({ data: { roomId, ownerId } });
  }

  /** The currently-open (LIVE) session for a room, if any. */
  getOpenSession(roomId: string): Promise<RoomLiveSession | null> {
    return this.prisma.roomLiveSession.findFirst({
      where: { roomId, status: RoomLiveSessionStatus.LIVE },
      orderBy: { startedAt: 'desc' },
    });
  }

  async closeSession(id: string, endedAt: Date, durationSeconds: number): Promise<void> {
    await this.prisma.roomLiveSession.update({
      where: { id },
      data: { endedAt, durationSeconds, status: RoomLiveSessionStatus.ENDED },
    });
  }

  async listByOwner(
    ownerId: string,
    skip: number,
    take: number,
  ): Promise<[RoomLiveSession[], number]> {
    const where = { ownerId };
    return this.prisma.$transaction([
      this.prisma.roomLiveSession.findMany({
        where,
        skip,
        take,
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.roomLiveSession.count({ where }),
    ]);
  }

  findByIdForOwner(ownerId: string, id: string): Promise<RoomLiveSession | null> {
    return this.prisma.roomLiveSession.findFirst({ where: { id, ownerId } });
  }
}
