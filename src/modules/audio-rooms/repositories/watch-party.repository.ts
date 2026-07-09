import { Injectable } from '@nestjs/common';
import { RoomWatchParty, WatchPartyStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** Data layer for the per-room YouTube watch-party sync state (1:1). */
@Injectable()
export class WatchPartyRepository {
  constructor(private readonly prisma: PrismaService) {}

  get(roomId: string): Promise<RoomWatchParty | null> {
    return this.prisma.roomWatchParty.findUnique({ where: { roomId } });
  }

  upsert(
    roomId: string,
    data: {
      videoId: string | null;
      status: WatchPartyStatus;
      positionSeconds: number;
      controlledBy: string;
    },
  ): Promise<RoomWatchParty> {
    return this.prisma.roomWatchParty.upsert({
      where: { roomId },
      create: { roomId, ...data },
      update: data,
    });
  }
}
