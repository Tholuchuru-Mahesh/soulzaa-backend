import { Injectable, Logger } from '@nestjs/common';
import {
  BackpackItemSource,
  BackpackItemType,
  TreasureRewardKind,
  TreasureRewardStatus,
  WalletTxnReason,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RewardDistributor } from './reward-distributor.service';
import { TreasureConfigurationService } from './treasure-configuration.service';
import { TreasureRepository } from '../repositories/treasure.repository';

export interface DistributedItemReward {
  userId: string;
  rank: number;
  kind: 'BACKPACK_ITEM';
  itemType: string | null;
  itemName: string | null;
  backpackItemId: string | null;
}

export interface DistributionResult {
  boxId: string;
  winnersCount: number;
  distributions: DistributedItemReward[];
}

@Injectable()
export class TreasureDistributionService {
  private readonly logger = new Logger(TreasureDistributionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: TreasureRepository,
    private readonly configService: TreasureConfigurationService,
    private readonly distributor: RewardDistributor,
  ) {}

  /**
   * Calculates Top 3 Contributors for this specific box and rewards them with exclusive Backpack Inventory items.
   * NO COINS ARE DISTRIBUTED. ZERO WALLET CREDIT TRANSACTIONS.
   */
  async distributeBoxRewards(
    sessionId: string,
    boxId: string,
    roomId: string,
    level: number,
  ): Promise<DistributionResult> {
    // 1. Calculate Top 3 Contributors ONLY for this specific box
    const topContributors = await this.repo.topContributors(boxId, 3);

    if (topContributors.length === 0) {
      this.logger.warn(`No contributors found for box ${boxId}`);
      return { boxId, winnersCount: 0, distributions: [] };
    }

    const recipients = topContributors.map((t, idx) => ({
      rank: idx + 1,
      userId: t.userId,
    }));

    // 2. Fetch configurable rewards for this level
    let rewards = await this.configService.getLevelRewards(level);

    if (!rewards || rewards.length === 0) {
      const levelNames = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];
      const prefix = levelNames[Math.min(level - 1, 4)] || 'Exclusive';
      rewards = [
        {
          rank: 1,
          kind: 'BACKPACK_ITEM',
          itemType: BackpackItemType.THEME,
          itemName: `${prefix} Entry Theme`,
        },
        {
          rank: 2,
          kind: 'BACKPACK_ITEM',
          itemType: BackpackItemType.FRAME,
          itemName: `${prefix} Profile Frame`,
        },
        {
          rank: 3,
          kind: 'BACKPACK_ITEM',
          itemType: BackpackItemType.BADGE,
          itemName: `${prefix} Contributor Badge`,
        },
      ];
    }

    // Filter out any legacy COINS entries, converting them to Backpack Item rewards
    const inventoryRewards = rewards.map((r) => {
      if (r.kind === 'COINS') {
        const levelNames = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];
        const prefix = levelNames[Math.min(level - 1, 4)] || 'Exclusive';
        return {
          rank: r.rank,
          kind: 'BACKPACK_ITEM' as const,
          itemType:
            r.rank === 1
              ? BackpackItemType.THEME
              : r.rank === 2
                ? BackpackItemType.FRAME
                : BackpackItemType.BADGE,
          itemName:
            r.rank === 1
              ? `${prefix} Entry Theme`
              : r.rank === 2
                ? `${prefix} Profile Frame`
                : `${prefix} Contributor Badge`,
        };
      }
      return r;
    });

    // 3. Grant inventory items directly to recipient Backpacks (Idempotent per boxId)
    const distributed = await this.distributor.distribute({
      recipients,
      rewards: inventoryRewards,
      idempotencyPrefix: `tb-open:${boxId}`,
      walletReason: WalletTxnReason.TREASURE_BOX,
      backpackSource: BackpackItemSource.TREASURE_BOX,
      referenceType: 'treasure_box',
      referenceId: boxId,
    });

    // 4. Store immutable TreasureReward entries for audit & UI
    const distributions: DistributedItemReward[] = [];
    for (const d of distributed) {
      await this.prisma.treasureReward.create({
        data: {
          sessionId,
          boxId,
          roomId,
          level,
          userId: d.userId,
          rank: d.rank,
          kind: TreasureRewardKind.BACKPACK_ITEM,
          coins: null,
          itemType: d.itemType,
          itemName: d.itemName,
          backpackItemId: d.backpackItemId,
          status: TreasureRewardStatus.DISTRIBUTED,
          distributedAt: new Date(),
        },
      });

      distributions.push({
        userId: d.userId,
        rank: d.rank,
        kind: 'BACKPACK_ITEM',
        itemType: d.itemType,
        itemName: d.itemName,
        backpackItemId: d.backpackItemId,
      });
    }

    return {
      boxId,
      winnersCount: distributions.length,
      distributions,
    };
  }
}
