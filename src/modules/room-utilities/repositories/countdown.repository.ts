import { Injectable } from '@nestjs/common';
import { RoomCountdown, RoomCountdownStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

const NON_TERMINAL: RoomCountdownStatus[] = [
  RoomCountdownStatus.RUNNING,
  RoomCountdownStatus.PAUSED,
];

/**
 * Data layer for room countdowns: at most one non-terminal (RUNNING/PAUSED)
 * countdown per room. The tick monitor sweeps RUNNING countdowns whose `endsAt`
 * has elapsed.
 */
@Injectable()
export class CountdownRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: {
    roomId: string;
    creatorId: string;
    label: string | null;
    durationSeconds: number;
    endsAt: Date;
  }): Promise<RoomCountdown> {
    return this.prisma.roomCountdown.create({
      data: {
        roomId: data.roomId,
        creatorId: data.creatorId,
        label: data.label,
        durationSeconds: data.durationSeconds,
        remainingSeconds: data.durationSeconds,
        status: RoomCountdownStatus.RUNNING,
        endsAt: data.endsAt,
      },
    });
  }

  findById(id: string): Promise<RoomCountdown | null> {
    return this.prisma.roomCountdown.findUnique({ where: { id } });
  }

  findActive(roomId: string): Promise<RoomCountdown | null> {
    return this.prisma.roomCountdown.findFirst({
      where: { roomId, status: { in: NON_TERMINAL } },
      orderBy: { startedAt: 'desc' },
    });
  }

  update(
    id: string,
    data: Partial<{
      status: RoomCountdownStatus;
      remainingSeconds: number;
      endsAt: Date;
      completedAt: Date;
    }>,
  ): Promise<RoomCountdown> {
    return this.prisma.roomCountdown.update({ where: { id }, data });
  }

  listRunning(limit: number): Promise<RoomCountdown[]> {
    return this.prisma.roomCountdown.findMany({
      where: { status: RoomCountdownStatus.RUNNING },
      take: limit,
      orderBy: { endsAt: 'asc' },
    });
  }
}
