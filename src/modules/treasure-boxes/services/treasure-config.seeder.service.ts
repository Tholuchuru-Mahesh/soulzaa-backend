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
      { rank: 1, kind: 'COINS', coins: 5_000 },
      { rank: 2, kind: 'COINS', coins: 2_000 },
      { rank: 3, kind: 'COINS', coins: 1_000 },
    ],
  },
  {
    level: 2,
    threshold: 60_000,
    rewards: [
      { rank: 1, kind: 'COINS', coins: 20_000 },
      { rank: 2, kind: 'COINS', coins: 8_000 },
      { rank: 3, kind: 'COINS', coins: 4_000 },
    ],
  },
  {
    level: 3,
    threshold: 200_000,
    rewards: [
      { rank: 1, kind: 'COINS', coins: 70_000 },
      { rank: 2, kind: 'COINS', coins: 25_000 },
      { rank: 3, kind: 'COINS', coins: 12_000 },
    ],
  },
  {
    level: 4,
    threshold: 350_000,
    rewards: [
      {
        rank: 1,
        kind: 'BACKPACK_ITEM',
        itemType: BackpackItemType.FRAME,
        itemName: 'Treasure Hunter Frame',
      },
      { rank: 1, kind: 'COINS', coins: 120_000 },
      { rank: 2, kind: 'COINS', coins: 45_000 },
      { rank: 3, kind: 'COINS', coins: 20_000 },
    ],
  },
  {
    level: 5,
    threshold: 500_000,
    rewards: [
      {
        rank: 1,
        kind: 'BACKPACK_ITEM',
        itemType: BackpackItemType.ENTRANCE_EFFECT,
        itemName: 'Golden Treasure Entrance',
      },
      { rank: 1, kind: 'COINS', coins: 200_000 },
      { rank: 2, kind: 'COINS', coins: 75_000 },
      { rank: 3, kind: 'COINS', coins: 30_000 },
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
