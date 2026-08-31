import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TreasureRepository } from '../repositories/treasure.repository';

/**
 * Seeds the 5-level treasure box ladder on a fresh database (ascending gift-value
 * thresholds per the PRD). Rewards are intentionally NOT seeded — they are
 * configured entirely from the Super Admin panel by picking existing catalog
 * assets (room themes / entry effects / profile frames) or setting a free-coin
 * amount. A level with no configured rewards simply distributes nothing when its
 * box opens. Idempotent by level: thresholds are only inserted, never overwritten,
 * so operator tuning via the admin API is preserved across restarts.
 */
const SEED_THRESHOLDS: { level: number; threshold: number }[] = [
  { level: 1, threshold: 15_000 },
  { level: 2, threshold: 60_000 },
  { level: 3, threshold: 120_000 },
  { level: 4, threshold: 300_000 },
  { level: 5, threshold: 500_000 },
];

@Injectable()
export class TreasureConfigSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(TreasureConfigSeeder.name);

  constructor(private readonly repo: TreasureRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      let created = 0;
      for (const l of SEED_THRESHOLDS) {
        const inserted = await this.repo.seedConfig(
          l.level,
          BigInt(l.threshold),
          [] as unknown as Prisma.InputJsonValue,
        );
        if (inserted) created += 1;
      }
      if (created > 0) this.logger.log(`Seeded ${created} treasure box level thresholds`);
    } catch (err) {
      this.logger.warn(`Treasure config seed skipped: ${(err as Error).message}`);
    }
  }
}
