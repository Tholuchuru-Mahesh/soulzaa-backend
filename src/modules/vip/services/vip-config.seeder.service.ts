import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CosmeticRarity, CosmeticType, Prisma } from '@prisma/client';
import { VipLevel } from 'src/common/enums/vip-level.enum';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import type { VipBenefit } from '../constants/vip.constants';
import { VipRepository } from '../repositories/vip.repository';
import { VipService } from './vip.service';

/**
 * Seeds the 7 VIP tiers (Bronze→Titan) on a fresh database with ascending
 * lifetime-recharge thresholds and a signature benefit cosmetic per tier
 * (badge/frame/entrance-effect, resolved via COSMETICS_SERVICE.ensureCosmetic).
 * Idempotent by tier; operators tune via the admin config API. Reloads the VIP
 * cache after seeding.
 */
const TIERS: {
  level: VipLevel;
  minRecharge: number;
  cosmeticName: string;
  type: CosmeticType;
  rarity: CosmeticRarity;
}[] = [
  {
    level: VipLevel.BRONZE,
    minRecharge: 10_000,
    cosmeticName: 'Bronze VIP Badge',
    type: CosmeticType.BADGE,
    rarity: CosmeticRarity.COMMON,
  },
  {
    level: VipLevel.SILVER,
    minRecharge: 50_000,
    cosmeticName: 'Silver VIP Badge',
    type: CosmeticType.BADGE,
    rarity: CosmeticRarity.COMMON,
  },
  {
    level: VipLevel.GOLD,
    minRecharge: 200_000,
    cosmeticName: 'Gold VIP Frame',
    type: CosmeticType.FRAME,
    rarity: CosmeticRarity.RARE,
  },
  {
    level: VipLevel.PLATINUM,
    minRecharge: 500_000,
    cosmeticName: 'Platinum VIP Frame',
    type: CosmeticType.FRAME,
    rarity: CosmeticRarity.RARE,
  },
  {
    level: VipLevel.DIAMOND,
    minRecharge: 1_500_000,
    cosmeticName: 'Diamond VIP Entrance',
    type: CosmeticType.ENTRANCE_EFFECT,
    rarity: CosmeticRarity.EPIC,
  },
  {
    level: VipLevel.ELITE,
    minRecharge: 5_000_000,
    cosmeticName: 'Elite VIP Entrance',
    type: CosmeticType.ENTRANCE_EFFECT,
    rarity: CosmeticRarity.EPIC,
  },
  {
    level: VipLevel.TITAN,
    minRecharge: 15_000_000,
    cosmeticName: 'Titan VIP Frame',
    type: CosmeticType.FRAME,
    rarity: CosmeticRarity.LEGENDARY,
  },
];

@Injectable()
export class VipConfigSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(VipConfigSeeder.name);

  constructor(
    private readonly repo: VipRepository,
    private readonly vip: VipService,
    @Inject(COSMETICS_SERVICE) private readonly cosmetics: ICosmeticsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      let created = 0;
      for (const tier of TIERS) {
        const cosmeticId = await this.cosmetics.ensureCosmetic({
          type: tier.type,
          name: tier.cosmeticName,
          rarity: tier.rarity,
        });
        const benefits: VipBenefit[] = [
          { kind: 'COSMETIC', cosmeticId },
          { kind: 'PERK', description: `${tier.level} VIP privileges` },
        ];
        const inserted = await this.repo.seedConfig(
          tier.level,
          BigInt(tier.minRecharge),
          benefits as unknown as Prisma.InputJsonValue,
        );
        if (inserted) created += 1;
      }
      if (created > 0) {
        await this.vip.reload();
        this.logger.log(`Seeded ${created} VIP tier configs`);
      }
    } catch (err) {
      this.logger.warn(`VIP config seed skipped: ${(err as Error).message}`);
    }
  }
}
