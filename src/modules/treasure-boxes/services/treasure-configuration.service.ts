import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';

export interface TreasureLevelConfig {
  level: number;
  threshold: bigint;
  rewards: any[];
}

export const PRD_BOX_THRESHOLDS: Record<number, bigint> = {
  1: BigInt(15_000),
  2: BigInt(60_000),
  3: BigInt(120_000),
  4: BigInt(300_000),
  5: BigInt(500_000),
};

export const TOTAL_DAILY_CAPACITY = BigInt(995_000);

@Injectable()
export class TreasureConfigurationService {
  private readonly logger = new Logger(TreasureConfigurationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformConfig: ConfigurationEngineService,
  ) {}

  /**
   * Retrieves the configured rewards JSON array for a specific level (1..5).
   */
  async getLevelRewards(level: number): Promise<any[]> {
    const config = await this.prisma.treasureBoxConfig.findUnique({
      where: { level },
    });
    if (config?.rewards && Array.isArray(config.rewards)) {
      return config.rewards;
    }
    return [];
  }

  /**
   * Retrieves the configured box threshold for a specific level (1..5).
   */
  async getLevelThreshold(level: number): Promise<bigint> {
    const config = await this.prisma.treasureBoxConfig.findUnique({
      where: { level },
    });
    if (config?.threshold) {
      return config.threshold;
    }
    return PRD_BOX_THRESHOLDS[level] ?? BigInt(15_000);
  }

  /**
   * Retrieves all 5 level configurations.
   */
  async getAllLevelConfigs(): Promise<TreasureLevelConfig[]> {
    const configs = await this.prisma.treasureBoxConfig.findMany({
      where: { enabled: true },
      orderBy: { level: 'asc' },
    });

    if (configs.length > 0) {
      return configs.map((c) => ({
        level: c.level,
        threshold: c.threshold,
        rewards: Array.isArray(c.rewards) ? c.rewards : [],
      }));
    }

    // Default 5-level PRD thresholds
    return [1, 2, 3, 4, 5].map((lvl) => ({
      level: lvl,
      threshold: PRD_BOX_THRESHOLDS[lvl],
      rewards: [],
    }));
  }

  /**
   * Gets reward pool percentage from PlatformConfigurationService (default 50%).
   */
  async getRewardPoolPercentage(): Promise<number> {
    try {
      const val = await this.platformConfig.get<number>('treasure.reward_pool_percentage');
      if (typeof val === 'number' && val > 0 && val <= 100) {
        return val;
      }
    } catch {
      // Fallback default
    }
    return 50; // 50% default
  }

  /**
   * Gets eligible winners count bounds (default 5 to 7).
   */
  async getEligibleWinnersCountRange(): Promise<{ min: number; max: number }> {
    try {
      const min = (await this.platformConfig.get<number>('treasure.min_winners')) ?? 5;
      const max = (await this.platformConfig.get<number>('treasure.max_winners')) ?? 7;
      return { min, max };
    } catch {
      return { min: 5, max: 7 };
    }
  }

  /**
   * Upsert level configuration (Admin path).
   */
  async upsertLevelConfig(adminId: string, level: number, threshold: bigint, rewards: any[]) {
    return this.prisma.treasureBoxConfig.upsert({
      where: { level },
      update: {
        threshold,
        rewards,
        updatedBy: adminId,
      },
      create: {
        level,
        threshold,
        rewards,
        createdBy: adminId,
      },
    });
  }
}
