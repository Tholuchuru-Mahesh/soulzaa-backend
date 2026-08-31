import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import type { RewardEntry } from '../constants/treasure.constants';

export interface TreasureLevelConfig {
  level: number;
  threshold: bigint;
  rewards: any[];
}

/** A configured reward with the granting cosmetic's art resolved for display. */
export interface ResolvedRewardEntry {
  rank: number;
  kind: 'COINS' | 'BACKPACK_ITEM';
  coins: number | null;
  itemType: string | null;
  itemName: string | null;
  itemRefId: string | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  /** Days the cosmetic lasts before removal; 0 = permanent. null for COINS. */
  ttlDays: number | null;
}

/** A level's configured prize list (for the app's "prizes per box" view). */
export interface LevelRewardView {
  level: number;
  threshold: number;
  enabled: boolean;
  rewards: ResolvedRewardEntry[];
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
    private readonly media: MediaUrlResolver,
  ) {}

  /**
   * The configured prize list for every level (1..5), with each cosmetic
   * reward's catalog art resolved to a servable URL. Drives the app's
   * "prizes per box" view — visible before any box opens. Never throws on a
   * missing catalog row; a stale entry just carries null art.
   */
  async getAllLevelRewardViews(): Promise<LevelRewardView[]> {
    const configs = await this.prisma.treasureBoxConfig.findMany({
      orderBy: { level: 'asc' },
    });

    const refIds = Array.from(
      new Set(
        configs
          .flatMap((c) => (Array.isArray(c.rewards) ? (c.rewards as unknown as RewardEntry[]) : []))
          .map((r) => r.itemRefId)
          .filter((id): id is string => !!id),
      ),
    );

    const artByRef = new Map<string, { mediaUrl: string | null; thumbnailUrl: string | null }>();
    if (refIds.length > 0) {
      const cosmetics = await this.prisma.cosmetic.findMany({
        where: { id: { in: refIds } },
        select: { id: true, mediaUrl: true, thumbnailUrl: true },
      });
      for (const c of cosmetics) {
        artByRef.set(c.id, {
          mediaUrl: await this.media.resolve(c.mediaUrl),
          thumbnailUrl: await this.media.resolve(c.thumbnailUrl ?? c.mediaUrl),
        });
      }
    }

    return configs.map((c) => ({
      level: c.level,
      threshold: Number(c.threshold),
      enabled: c.enabled,
      rewards: this.resolveRewardList(
        Array.isArray(c.rewards) ? (c.rewards as unknown as RewardEntry[]) : [],
        artByRef,
      ),
    }));
  }

  private resolveRewardList(
    rewards: RewardEntry[],
    artByRef: Map<string, { mediaUrl: string | null; thumbnailUrl: string | null }>,
  ): ResolvedRewardEntry[] {
    return rewards
      .filter((r) => r.kind === 'COINS' || !!r.itemRefId)
      .map((r) => {
        const art = r.itemRefId ? artByRef.get(r.itemRefId) : undefined;
        return {
          rank: r.rank,
          kind: r.kind,
          coins: r.kind === 'COINS' && r.coins ? Number(r.coins) : null,
          itemType: r.itemType ?? null,
          itemName: r.itemName ?? null,
          itemRefId: r.itemRefId ?? null,
          mediaUrl: art?.mediaUrl ?? null,
          thumbnailUrl: art?.thumbnailUrl ?? null,
          ttlDays: r.kind === 'BACKPACK_ITEM' ? (r.ttlDays ?? 0) : null,
        };
      })
      .sort((a, b) => a.rank - b.rank);
  }

  /** Resolved prize list for a single level. */
  async getLevelRewardView(level: number): Promise<ResolvedRewardEntry[]> {
    const views = await this.getAllLevelRewardViews();
    return views.find((v) => v.level === level)?.rewards ?? [];
  }

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
