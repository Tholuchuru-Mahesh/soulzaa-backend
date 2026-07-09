import { Injectable } from '@nestjs/common';
import { RoomAppearance } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** Data layer for the per-room active appearance (theme + decorations). */
@Injectable()
export class RoomAppearanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  get(roomId: string): Promise<RoomAppearance | null> {
    return this.prisma.roomAppearance.findUnique({ where: { roomId } });
  }

  setTheme(
    roomId: string,
    themeCosmeticId: string | null,
    themeName: string | null,
    updatedBy: string,
  ): Promise<RoomAppearance> {
    return this.prisma.roomAppearance.upsert({
      where: { roomId },
      create: { roomId, themeCosmeticId, themeName, updatedBy },
      update: { themeCosmeticId, themeName, updatedBy },
    });
  }

  setDecorations(
    roomId: string,
    decorationCosmeticIds: string[],
    decorationNames: string[],
    updatedBy: string,
  ): Promise<RoomAppearance> {
    return this.prisma.roomAppearance.upsert({
      where: { roomId },
      create: { roomId, decorationCosmeticIds, decorationNames, updatedBy },
      update: { decorationCosmeticIds, decorationNames, updatedBy },
    });
  }

  reset(roomId: string, updatedBy: string): Promise<RoomAppearance> {
    return this.prisma.roomAppearance.upsert({
      where: { roomId },
      create: { roomId, updatedBy },
      update: {
        themeCosmeticId: null,
        themeName: null,
        decorationCosmeticIds: [],
        decorationNames: [],
        updatedBy,
      },
    });
  }
}
