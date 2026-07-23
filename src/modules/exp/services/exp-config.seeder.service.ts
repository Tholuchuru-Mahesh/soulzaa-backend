import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CosmeticRarity, CosmeticType, Prisma } from '@prisma/client';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import type { RewardEntry } from '../constants/exp.constants';
import { ExpRepository } from '../repositories/exp.repository';
import { ExpService } from './exp.service';

/**
 * Seeds the user + room level ladders on a fresh database so EXP progression
 * works immediately. User levels 1–20 follow a quadratic EXP curve with scaling
 * free-coin rewards and milestone cosmetics (badge/frame/entrance effect,
 * resolved via COSMETICS_SERVICE.ensureCosmetic). Idempotent by level; operators
 * tune via the admin config API. Reloads the EXP cache after seeding.
 */
@Injectable()
export class ExpConfigSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExpConfigSeeder.name);

  constructor(
    private readonly repo: ExpRepository,
    private readonly exp: ExpService,
    @Inject(COSMETICS_SERVICE) private readonly cosmetics: ICosmeticsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const created = await this.seed();
      if (created > 0) {
        await this.exp.reload();
        this.logger.log(`Seeded ${created} level configs`);
      }
    } catch (err) {
      this.logger.warn(`Level config seed skipped: ${(err as Error).message}`);
    }
  }

  private async seed(): Promise<number> {
    const badge = await this.cosmetics.ensureCosmetic({
      type: CosmeticType.BADGE,
      name: 'Bronze Achiever',
      rarity: CosmeticRarity.COMMON,
    });
    const frame = await this.cosmetics.ensureCosmetic({
      type: CosmeticType.FRAME,
      name: 'Silver Frame',
      rarity: CosmeticRarity.RARE,
    });
    const entrance = await this.cosmetics.ensureCosmetic({
      type: CosmeticType.ENTRANCE_EFFECT,
      name: 'Rising Star Entrance',
      rarity: CosmeticRarity.EPIC,
    });
    const legend = await this.cosmetics.ensureCosmetic({
      type: CosmeticType.FRAME,
      name: 'Legend Frame',
      rarity: CosmeticRarity.LEGENDARY,
    });
    const milestones: Record<number, string> = { 5: badge, 10: frame, 15: entrance, 20: legend };

    let created = 0;
    for (let level = 1; level <= 20; level++) {
      const minExp = BigInt(100 * (level - 1) * (level - 1));
      const rewards: RewardEntry[] = [];
      if (level > 1) rewards.push({ kind: 'COINS', coins: level * 100, currency: 'FREE' });
      if (milestones[level]) rewards.push({ kind: 'COSMETIC', cosmeticId: milestones[level] });
      const inserted = await this.repo.seedLevelConfig(
        level,
        minExp,
        `Level ${level}`,
        rewards as unknown as Prisma.InputJsonValue,
      );
      if (inserted) created += 1;
    }

    const roomLevels: [number, number][] = [
      [1, 0],
      [2, 5_000],
      [3, 20_000],
      [4, 50_000],
      [5, 100_000],
    ];
    for (const [level, minExp] of roomLevels) {
      const inserted = await this.repo.seedLevelConfig(
        level,
        BigInt(minExp),
        `Room Level ${level}`,
        [],
      );
      if (inserted) created += 1;
    }
    return created;
  }
}
