import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { GiftCategory, GiftType, Prisma } from '@prisma/client';
import { GiftRepository } from '../repositories/gift.repository';

/**
 * A starter gift catalog spanning every type (static/animated/combo/lucky/
 * festival/premium) and category (classic→vip), so the send flow and
 * shelves work on a fresh database. Operators curate the real catalog via the
 * admin CRUD; this only guarantees a non-empty, representative set and never
 * clobbers existing rows (seeded by unique code).
 */
const SEED_GIFTS: Prisma.GiftUncheckedCreateInput[] = [
  {
    code: 'rose',
    name: 'Rose',
    category: GiftCategory.CLASSIC,
    type: GiftType.STATIC,
    coinValue: 1,
    sortOrder: 1,
  },
  {
    code: 'heart',
    name: 'Heart',
    category: GiftCategory.CLASSIC,
    type: GiftType.STATIC,
    coinValue: 5,
    sortOrder: 2,
  },
  {
    code: 'teddy-bear',
    name: 'Teddy Bear',
    category: GiftCategory.CLASSIC,
    type: GiftType.ANIMATED,
    coinValue: 50,
    sortOrder: 3,
  },
  {
    code: 'kiss-combo',
    name: 'Kiss Combo',
    category: GiftCategory.CLASSIC,
    type: GiftType.COMBO,
    coinValue: 10,
    comboEnabled: true,
    comboWindowSeconds: 10,
    sortOrder: 4,
  },
  {
    code: 'fireworks',
    name: 'Fireworks',
    category: GiftCategory.PREMIUM,
    type: GiftType.ANIMATED,
    coinValue: 200,
    sortOrder: 5,
  },
  {
    code: 'lucky-box',
    name: 'Lucky Box',
    category: GiftCategory.SPECIAL_EVENT,
    type: GiftType.LUCKY,
    coinValue: 100,
    luckyMultipliers: [2, 5, 10, 50],
    luckyWinChanceBp: 2000,
    sortOrder: 6,
  },
  {
    code: 'diwali-lamp',
    name: 'Diwali Lamp',
    category: GiftCategory.FESTIVAL,
    type: GiftType.FESTIVAL,
    coinValue: 88,
    festivalTag: 'diwali',
    sortOrder: 7,
  },
  {
    code: 'sports-car',
    name: 'Sports Car',
    category: GiftCategory.LUXURY,
    type: GiftType.ANIMATED,
    coinValue: 5000,
    sortOrder: 8,
  },
  {
    code: 'rocket',
    name: 'Rocket',
    category: GiftCategory.PREMIUM,
    type: GiftType.PREMIUM,
    coinValue: 10000,
    sortOrder: 9,
  },
  {
    code: 'diamond-ring',
    name: 'Diamond Ring',
    category: GiftCategory.LUXURY,
    type: GiftType.PREMIUM,
    coinValue: 30000,
    sortOrder: 10,
  },
  {
    code: 'golden-crown',
    name: 'Golden Crown',
    category: GiftCategory.VIP,
    type: GiftType.PREMIUM,
    coinValue: 8888,
    minVipLevel: 3,
    sortOrder: 11,
  },
  {
    code: 'castle',
    name: 'Castle',
    category: GiftCategory.LUXURY,
    type: GiftType.ANIMATED,
    coinValue: 20000,
    sortOrder: 12,
  },
];

@Injectable()
export class GiftCatalogSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(GiftCatalogSeeder.name);

  constructor(private readonly repo: GiftRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      let created = 0;
      for (const gift of SEED_GIFTS) {
        if (await this.repo.seedGift(gift)) created += 1;
      }
      if (created > 0) this.logger.log(`Seeded ${created} catalog gifts`);
    } catch (err) {
      this.logger.warn(`Gift catalog seed skipped: ${(err as Error).message}`);
    }
  }
}
