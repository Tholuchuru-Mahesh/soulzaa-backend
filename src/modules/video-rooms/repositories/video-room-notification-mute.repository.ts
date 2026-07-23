import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** Durable per-room notification mutes (VR-15). Idempotent create via upsert. */
@Injectable()
export class VideoRoomNotificationMuteRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, roomId: string): Promise<void> {
    await this.prisma.videoRoomNotificationMute.upsert({
      where: { userId_roomId: { userId, roomId } },
      create: { userId, roomId },
      update: {},
    });
  }

  async remove(userId: string, roomId: string): Promise<void> {
    await this.prisma.videoRoomNotificationMute.deleteMany({ where: { userId, roomId } });
  }

  async list(userId: string): Promise<string[]> {
    const rows = await this.prisma.videoRoomNotificationMute.findMany({
      where: { userId },
      select: { roomId: true },
    });
    return rows.map((r) => r.roomId);
  }

  async exists(userId: string, roomId: string): Promise<boolean> {
    const row = await this.prisma.videoRoomNotificationMute.findUnique({
      where: { userId_roomId: { userId, roomId } },
      select: { id: true },
    });
    return row !== null;
  }
}
