import { Injectable } from '@nestjs/common';
import { VideoRoomBackground, VideoRoomTheme } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { SeedVideoRoomBackground, SeedVideoRoomTheme } from '../constants/reference-data';

/**
 * Persistence for the seeded reference tables `video_room_themes` /
 * `video_room_backgrounds`. Read paths serve the client's theme/background
 * pickers; the seed path (idempotent upsert-by-slug) is used by
 * VideoRoomReferenceSeederService on bootstrap. Rooms reference these BY VALUE
 * (video_rooms.themeId / .backgroundId) — no cross-table FK.
 */
@Injectable()
export class VideoRoomReferenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Themes ----

  /** Active themes for the picker, in display order. */
  async listActiveThemes(): Promise<VideoRoomTheme[]> {
    return this.prisma.videoRoomTheme.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async findThemeById(id: string): Promise<VideoRoomTheme | null> {
    return this.prisma.videoRoomTheme.findUnique({ where: { id } });
  }

  /** Idempotent seed (upsert by slug). Returns the row. */
  async upsertTheme(seed: SeedVideoRoomTheme): Promise<VideoRoomTheme> {
    return this.prisma.videoRoomTheme.upsert({
      where: { slug: seed.slug },
      create: {
        slug: seed.slug,
        name: seed.name,
        isPremium: seed.isPremium,
        sortOrder: seed.sortOrder,
      },
      update: { name: seed.name, isPremium: seed.isPremium, sortOrder: seed.sortOrder },
    });
  }

  async countThemes(): Promise<number> {
    return this.prisma.videoRoomTheme.count();
  }

  // ---- Backgrounds ----

  /** Active backgrounds for the picker, in display order. */
  async listActiveBackgrounds(): Promise<VideoRoomBackground[]> {
    return this.prisma.videoRoomBackground.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async findBackgroundById(id: string): Promise<VideoRoomBackground | null> {
    return this.prisma.videoRoomBackground.findUnique({ where: { id } });
  }

  /** Idempotent seed (upsert by slug). Returns the row. */
  async upsertBackground(seed: SeedVideoRoomBackground): Promise<VideoRoomBackground> {
    return this.prisma.videoRoomBackground.upsert({
      where: { slug: seed.slug },
      create: {
        slug: seed.slug,
        name: seed.name,
        isPremium: seed.isPremium,
        sortOrder: seed.sortOrder,
      },
      update: { name: seed.name, isPremium: seed.isPremium, sortOrder: seed.sortOrder },
    });
  }

  async countBackgrounds(): Promise<number> {
    return this.prisma.videoRoomBackground.count();
  }
}
