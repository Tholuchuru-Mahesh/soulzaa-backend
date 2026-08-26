import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { WealthRepository } from '../repositories/wealth.repository';

/** The 13 Wealth Level tiers. Index = level ordinal. */
const WEALTH_LEVELS: { level: number; name: string; expThreshold: number }[] = [
  { level: 0, name: 'Normal User', expThreshold: 0 },
  { level: 1, name: 'Prestige', expThreshold: 10_000 },
  { level: 2, name: 'Rise', expThreshold: 30_000 },
  { level: 3, name: 'Nova', expThreshold: 75_000 },
  { level: 4, name: 'Elite', expThreshold: 150_000 },
  { level: 5, name: 'Royal', expThreshold: 300_000 },
  { level: 6, name: 'Crown', expThreshold: 600_000 },
  { level: 7, name: 'Legend', expThreshold: 1_200_000 },
  { level: 8, name: 'Titan', expThreshold: 2_500_000 },
  { level: 9, name: 'Supreme', expThreshold: 5_000_000 },
  { level: 10, name: 'Infinity', expThreshold: 10_000_000 },
  { level: 11, name: 'Celestial', expThreshold: 20_000_000 },
  { level: 12, name: 'Immortal', expThreshold: 40_000_000 },
];

/** Idempotent bootstrap seed of the 13 Wealth Level tiers — a no-op once a level row exists. */
@Injectable()
export class WealthConfigSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(WealthConfigSeeder.name);

  constructor(private readonly repo: WealthRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    let seeded = 0;
    for (const [i, l] of WEALTH_LEVELS.entries()) {
      const created = await this.repo.seedLevel(l.level, {
        name: l.name,
        expThreshold: BigInt(l.expThreshold),
        displayOrder: i,
      });
      if (created) seeded += 1;
    }
    if (seeded > 0) {
      this.logger.log(`Seeded ${seeded} Wealth Level tier(s).`);
    }
  }
}
