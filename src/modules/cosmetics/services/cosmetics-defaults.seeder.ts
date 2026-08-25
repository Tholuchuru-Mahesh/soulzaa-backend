import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * The one cosmetic the code cannot run without.
 *
 * `CosmeticsService.equip` writes a `UserCosmetic` pointing at this exact id
 * whenever a user equips any frame, and `ProfileService.resolveEquippedFrame`
 * looks it up by the same literal. With the row missing, that write fails its
 * foreign key — so this is a schema fixture, not a catalog entry.
 *
 * `mediaUrl` is the sentinel `default_pink_frame` rather than a URL: the app
 * matches on that string in `AppAvatar` and draws a bundled asset, so it never
 * makes a network request for it.
 */
const DEFAULT_PINK_CHARM = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Default Pink Charm',
  type: 'FRAME' as const,
  mediaUrl: 'default_pink_frame',
  thumbnailUrl: 'default_pink_frame',
  rarity: 'COMMON' as const,
  price: 0,
  isPremium: false,
  enabled: true,
  sortOrder: 1,
};

/**
 * Creates the default frame if it is absent, once, at boot.
 *
 * Create-only on purpose. The previous implementation upserted a whole list of
 * decorative frames from inside the store's *read* path, which meant an admin
 * could never delete or edit any of them — the next listing wrote the hardcoded
 * values back. Everything except the fixture above is now ordinary catalog data
 * that the console owns: delete it and it stays deleted.
 *
 * Note this never updates. An admin who renames or reprices the default frame
 * keeps that change across restarts; only its absence is corrected.
 */
@Injectable()
export class CosmeticsDefaultsSeeder implements OnModuleInit {
  private readonly logger = new Logger(CosmeticsDefaultsSeeder.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      const existing = await this.prisma.cosmetic.findUnique({
        where: { id: DEFAULT_PINK_CHARM.id },
        select: { id: true },
      });
      if (existing) return;

      await this.prisma.cosmetic.create({ data: DEFAULT_PINK_CHARM });
      this.logger.log(`Seeded default frame "${DEFAULT_PINK_CHARM.name}"`);
    } catch (err) {
      // A missing default degrades frame equipping; it must not stop the API
      // from booting, which would take the whole platform down for one row.
      this.logger.error(`Failed to seed the default frame: ${String(err)}`);
    }
  }
}
