import { Injectable } from '@nestjs/common';
import { PresenceState, PresenceStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** Durable presence snapshot store (`presence_state`). Redis holds the coarse
 * online set; this row survives restarts and backs `lastSeenAt` + rich status. */
@Injectable()
export class PresenceStateRepository {
  constructor(private readonly prisma: PrismaService) {}

  upsert(
    userId: string,
    data: { status: PresenceStatus; currentRoomId?: string | null; lastSeenAt?: Date | null },
  ): Promise<PresenceState> {
    return this.prisma.presenceState.upsert({
      where: { userId },
      create: {
        userId,
        status: data.status,
        currentRoomId: data.currentRoomId ?? null,
        lastSeenAt: data.lastSeenAt ?? null,
      },
      update: {
        status: data.status,
        currentRoomId: data.currentRoomId ?? null,
        ...(data.lastSeenAt !== undefined ? { lastSeenAt: data.lastSeenAt } : {}),
      },
    });
  }

  getMany(userIds: string[]): Promise<PresenceState[]> {
    if (userIds.length === 0) return Promise.resolve([]);
    return this.prisma.presenceState.findMany({ where: { userId: { in: userIds } } });
  }
}
