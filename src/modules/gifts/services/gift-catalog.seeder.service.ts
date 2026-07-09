import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { GiftCategory, GiftType, Prisma } from '@prisma/client';
import { GiftRepository } from '../repositories/gift.repository';

/**
 * A starter gift catalog spanning every type (static/animated/combo/lucky/
 * festival/premium) and category (standard→VIP-exclusive), so the send flow and
 * shelves work on a fresh database. Operators curate the real catalog via the
 * admin CRUD; this only guarantees a non-empty, representative set and never
 * clobbers existing rows (seeded by unique name).
 */
const SEED_GIFTS: Prisma.GiftUncheckedCreateInput[] = [
  {
    name: 'Rose',
    category: GiftCategory.STANDARD,
    type: GiftType.STATIC,
    coinValue: 1,
    sortOrder: 1,
  },
  {
    name: 'Heart',
    category: GiftCategory.STANDARD,
    type: GiftType.STATIC,
    coinValue: 5,
    sortOrder: 2,
  },
  {
    name: 'Teddy Bear',
    category: GiftCategory.STANDARD,
    type: GiftType.ANIMATED,
    coinValue: 50,
    sortOrder: 3,
  },
  {
    name: 'Kiss Combo',
    category: GiftCategory.STANDARD,
    type: GiftType.COMBO,
    coinValue: 10,
    comboEnabled: true,
    comboWindowSeconds: 10,
    sortOrder: 4,
  },
  {
    name: 'Fireworks',
    category: GiftCategory.PREMIUM,
    type: GiftType.ANIMATED,
    coinValue: 200,
    sortOrder: 5,
  },
  {
    name: 'Lucky Box',
    category: GiftCategory.EVENT,
    type: GiftType.LUCKY,
    coinValue: 100,
    luckyMultipliers: [2, 5, 10, 50],
    luckyWinChanceBp: 2000,
    sortOrder: 6,
  },
  {
    name: 'Diwali Lamp',
    category: GiftCategory.EVENT,
    type: GiftType.FESTIVAL,
    coinValue: 88,
    festivalTag: 'diwali',
    sortOrder: 7,
  },
  {
    name: 'Sports Car',
    category: GiftCategory.LUXURY,
    type: GiftType.ANIMATED,
    coinValue: 5000,
    sortOrder: 8,
  },
  {
    name: 'Rocket',
    category: GiftCategory.PREMIUM,
    type: GiftType.PREMIUM,
    coinValue: 10000,
    sortOrder: 9,
  },
  {
    name: 'Diamond Ring',
    category: GiftCategory.LUXURY,
    type: GiftType.PREMIUM,
    coinValue: 30000,
    sortOrder: 10,
  },
  {
    name: 'Golden Crown',
    category: GiftCategory.VIP_EXCLUSIVE,
    type: GiftType.PREMIUM,
    coinValue: 8888,
    minVipLevel: 3,
    sortOrder: 11,
  },
  {
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
