import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { DEFAULT_ROOM_CATEGORIES, DEFAULT_ROOM_LANGUAGES } from '../constants/reference-data';

/**
 * Idempotently seeds the default room categories + languages on bootstrap so the
 * discovery filters and GET /rooms/categories|languages return data on a fresh
 * database. Upserts by unique slug/code — safe to run on every instance
 * (concurrency is guarded by the unique constraints) and only writes rows that
 * are missing, so operator edits/deactivations are never clobbered.
 */
@Injectable()
export class RoomReferenceSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(RoomReferenceSeeder.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.seed();
    } catch (err) {
      // Never block startup on seed failures (e.g. migrations not yet applied).
      this.logger.warn(`Room reference seed skipped: ${(err as Error).message}`);
    }
  }

  private async seed(): Promise<void> {
    let created = 0;
    for (const c of DEFAULT_ROOM_CATEGORIES) {
      const res = await this.prisma.roomCategory.upsert({
        where: { slug: c.slug },
        create: { slug: c.slug, name: c.name, sortOrder: c.sortOrder },
        update: {},
      });
      if (res.createdAt.getTime() === res.updatedAt.getTime()) created += 1;
    }
    for (const l of DEFAULT_ROOM_LANGUAGES) {
      await this.prisma.roomLanguage.upsert({
        where: { code: l.code },
        create: { code: l.code, name: l.name, nativeName: l.nativeName, sortOrder: l.sortOrder },
        update: {},
      });
    }
    if (created > 0) this.logger.log(`Seeded ${created} new room categories`);
  }
}
