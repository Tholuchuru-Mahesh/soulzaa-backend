import { Injectable, Logger } from '@nestjs/common';
import {
  BackpackItemSource,
  TreasureRewardKind,
  TreasureRewardStatus,
  WalletTxnReason,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RewardDistributor } from './reward-distributor.service';
import { TreasureConfigurationService } from './treasure-configuration.service';
import { TreasureRepository } from '../repositories/treasure.repository';
import type { RewardEntry } from '../constants/treasure.constants';

export interface DistributedBoxReward {
  userId: string;
  rank: number;
  kind: TreasureRewardKind;
  coins: bigint | null;
  itemType: string | null;
  itemName: string | null;
  itemRefId: string | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  expiresAt: Date | null;
  backpackItemId: string | null;
  walletTxnId: string | null;
}

export interface DistributionResult {
  boxId: string;
  winnersCount: number;
  distributions: DistributedBoxReward[];
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
   * Calculates the Top Contributors for this specific box and rewards them with
   * the rewards configured for this level in the Super Admin panel (room themes,
   * entry effects, profile frames, free in-game coins). Nothing is hardcoded — a
   * level with no configured rewards distributes nothing.
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

    // 2. Fetch the rewards configured for this level (Super Admin panel). No
    //    fallback: an unconfigured level pays out nothing.
    const rewards: RewardEntry[] = await this.configService.getLevelRewards(level);
    if (!rewards || rewards.length === 0) {
      this.logger.warn(
        `Box ${boxId} (level ${level}) opened with no configured rewards — nothing distributed.`,
      );
      return { boxId, winnersCount: 0, distributions: [] };
    }

    // 3. Grant items to Backpack / credit Coins to Wallet (Idempotent per boxId)
    const distributed = await this.distributor.distribute({
      recipients,
      rewards,
      idempotencyPrefix: `tb-open:${boxId}`,
      walletReason: WalletTxnReason.TREASURE_BOX,
      backpackSource: BackpackItemSource.TREASURE_BOX,
      referenceType: 'treasure_box',
      referenceId: boxId,
    });

    // 4. Store immutable TreasureReward entries for audit & UI
    const distributions: DistributedBoxReward[] = [];
    for (const d of distributed) {
      await this.prisma.treasureReward.create({
        data: {
          sessionId,
          boxId,
          roomId,
          level,
          userId: d.userId,
          rank: d.rank,
          kind: d.kind,
          coins: d.coins,
          itemType: d.itemType,
          itemName: d.itemName,
          walletTxnId: d.walletTxnId,
          backpackItemId: d.backpackItemId,
          status: TreasureRewardStatus.DISTRIBUTED,
          distributedAt: new Date(),
        },
      });

      distributions.push({
        userId: d.userId,
        rank: d.rank,
        kind: d.kind,
        coins: d.coins,
        itemType: d.itemType,
        itemName: d.itemName,
        itemRefId: d.itemRefId,
        mediaUrl: d.mediaUrl,
        thumbnailUrl: d.thumbnailUrl,
        expiresAt: d.expiresAt,
        walletTxnId: d.walletTxnId,
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
