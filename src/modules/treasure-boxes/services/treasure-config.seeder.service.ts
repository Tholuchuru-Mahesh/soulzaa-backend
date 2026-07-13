import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { BackpackItemType, Prisma } from '@prisma/client';
import { TreasureRepository } from '../repositories/treasure.repository';
import type { RewardEntry } from '../constants/treasure.constants';

/**
 * Seeds the 5-level treasure box ladder on a fresh database (thresholds ascending
 * per the PRD, Top-3 coin rewards, plus a collectible frame for the rank-1 gifter
 * on the higher boxes). Idempotent by level — operators tune thresholds/rewards
 * via the admin config API. A treasure session cannot start until all 5 levels
 * are configured, so this guarantees the feature is usable out of the box.
 */
const SEED_LEVELS: { level: number; threshold: number; rewards: RewardEntry[] }[] = [
  {
    level: 1,
    threshold: 15_000,
    rewards: [
      { rank: 1, kind: 'BACKPACK_ITEM', itemType: BackpackItemType.THEME, itemName: 'Bronze Entry Theme' },
      { rank: 2, kind: 'BACKPACK_ITEM', itemType: BackpackItemType.FRAME, itemName: 'Bronze Profile Frame' },
      { rank: 3, kind: 'BACKPACK_ITEM', itemType: BackpackItemType.BADGE, itemName: 'Bronze Contributor Badge' },
    ],
  },
  {
    level: 2,
    threshold: 60_000,
    rewards: [
      { rank: 1, kind: 'BACKPACK_ITEM', itemType: BackpackItemType.THEME, itemName: 'Silver Entry Theme' },
      { rank: 2, kind: 'BACKPACK_ITEM', itemType: BackpackItemType.FRAME, itemName: 'Silver Profile Frame' },
      { rank: 3, kind: 'BACKPACK_ITEM', itemType: BackpackItemType.BADGE, itemName: 'Silver Contributor Badge' },
    ],
  },
  {
    level: 3,
    threshold: 120_000,
    rewards: [
      { rank: 1, kind: 'BACKPACK_ITEM', itemType: BackpackItemType.THEME, itemName: 'Gold Entry Theme' },
      { rank: 2, kind: 'BACKPACK_ITEM', itemType: BackpackItemType.FRAME, itemName: 'Gold Profile Frame' },
      { rank: 3, kind: 'BACKPACK_ITEM', itemType: BackpackItemType.BADGE, itemName: 'Gold Contributor Badge' },
    ],
  },
  {
    level: 4,
    threshold: 300_000,
    rewards: [
      { rank: 1, kind: 'BACKPACK_ITEM', itemType: BackpackItemType.THEME, itemName: 'Platinum Entry Theme' },
      { rank: 2, kind: 'BACKPACK_ITEM', itemType: BackpackItemType.FRAME, itemName: 'Platinum Profile Frame' },
      { rank: 3, kind: 'BACKPACK_ITEM', itemType: BackpackItemType.BADGE, itemName: 'Platinum Contributor Badge' },
    ],
  },
  {
    level: 5,
    threshold: 500_000,
    rewards: [
      { rank: 1, kind: 'BACKPACK_ITEM', itemType: BackpackItemType.THEME, itemName: 'Diamond Entry Theme' },
      { rank: 2, kind: 'BACKPACK_ITEM', itemType: BackpackItemType.FRAME, itemName: 'Diamond Profile Frame' },
      { rank: 3, kind: 'BACKPACK_ITEM', itemType: BackpackItemType.BADGE, itemName: 'Diamond Contributor Badge' },
    ],
  },
];

@Injectable()
export class TreasureConfigSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(TreasureConfigSeeder.name);

  constructor(private readonly repo: TreasureRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      let created = 0;
      for (const l of SEED_LEVELS) {
        const inserted = await this.repo.seedConfig(
          l.level,
          BigInt(l.threshold),
          l.rewards as unknown as Prisma.InputJsonValue,
        );
        if (inserted) created += 1;
      }
      if (created > 0) this.logger.log(`Seeded ${created} treasure box level configs`);
    } catch (err) {
      this.logger.warn(`Treasure config seed skipped: ${(err as Error).message}`);
    }
  }
}
