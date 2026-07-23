import { Inject, Injectable, Logger } from '@nestjs/common';
import { TreasureRewardKind, TreasureRewardStatus, WalletCurrency } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { TreasureConfigurationService } from './treasure-configuration.service';
import { EligibleParticipant, TreasureEligibilityService } from './treasure-eligibility.service';

export interface DistributionResult {
  boxId: string;
  totalRewardPool: bigint;
  winnersCount: number;
  distributions: Array<{
    userId: string;
    rank: number;
    coins: bigint;
    walletTxnId: string;
  }>;
}

@Injectable()
export class TreasureDistributionService {
  private readonly logger = new Logger(TreasureDistributionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibilityService: TreasureEligibilityService,
    private readonly configService: TreasureConfigurationService,
    @Inject(WALLET_SERVICE) private readonly walletService: IWalletService,
  ) {}

  /**
   * Performs weighted random selection to pick 5-7 winners and credits rewards using IWalletService.
   */
  async distributeBoxRewards(
    sessionId: string,
    boxId: string,
    roomId: string,
    level: number,
    totalRewardPool: bigint,
  ): Promise<DistributionResult> {
    const eligible = await this.eligibilityService.getEligibleParticipants(boxId, roomId);

    if (eligible.length === 0 || totalRewardPool <= BigInt(0)) {
      this.logger.warn(`No eligible participants or 0 pool for box ${boxId}`);
      return { boxId, totalRewardPool, winnersCount: 0, distributions: [] };
    }

    const bounds = await this.configService.getEligibleWinnersCountRange();
    const targetWinnersCount = Math.min(
      eligible.length,
      Math.max(bounds.min, Math.min(bounds.max, eligible.length)),
    );

    // 1. Weighted random selection of targetWinnersCount distinct winners
    const winners = this.weightedRandomSelect(eligible, targetWinnersCount);

    // 2. Allocate reward pool shares among winners
    // Highest weight receives rank 1 share down to rank N share
    const shares = this.allocatePoolShares(totalRewardPool, winners.length);

    const distributions: DistributionResult['distributions'] = [];

    for (let i = 0; i < winners.length; i++) {
      const winner = winners[i];
      const rank = i + 1;
      const coinReward = shares[i];

      if (coinReward <= BigInt(0)) continue;

      // Credit wallet via IWalletService (WalletTransactionService double-entry ledger)
      const creditRes = await this.walletService.credit({
        userId: winner.userId,
        currency: WalletCurrency.GOLD,
        amount: Number(coinReward),
        reason: 'TREASURE_BOX' as any,
        idempotencyKey: `treasure-reward:${boxId}:${winner.userId}:${rank}`,
        referenceType: 'treasure_box',
        referenceId: boxId,
        metadata: { roomId, level, rank },
      });

      const walletTxnId = creditRes?.transactionId ?? `tx-tr-${Date.now()}-${i}`;

      // Insert immutable TreasureReward record
      await this.prisma.treasureReward.create({
        data: {
          sessionId,
          boxId,
          roomId,
          level,
          userId: winner.userId,
          rank,
          kind: TreasureRewardKind.COINS,
          coins: coinReward,
          walletTxnId,
          status: TreasureRewardStatus.DISTRIBUTED,
          distributedAt: new Date(),
        },
      });

      distributions.push({
        userId: winner.userId,
        rank,
        coins: coinReward,
        walletTxnId,
      });
    }

    return {
      boxId,
      totalRewardPool,
      winnersCount: distributions.length,
      distributions,
    };
  }

  /**
   * Weighted random selection without replacement.
   */
  private weightedRandomSelect(pool: EligibleParticipant[], count: number): EligibleParticipant[] {
    const selected: EligibleParticipant[] = [];
    const remaining = [...pool];

    while (selected.length < count && remaining.length > 0) {
      let totalWeight = remaining.reduce((acc, p) => acc + p.weight, BigInt(0));
      if (totalWeight <= BigInt(0)) {
        // Fallback uniform random if weight zero
        const index = Math.floor(Math.random() * remaining.length);
        selected.push(remaining.splice(index, 1)[0]);
        continue;
      }

      // Convert BigInt totalWeight to random pick point
      const randVal = BigInt(Math.floor(Math.random() * 10000));
      const pickPoint = (totalWeight * randVal) / BigInt(10000);

      let currentSum = BigInt(0);
      let chosenIndex = 0;

      for (let i = 0; i < remaining.length; i++) {
        currentSum += remaining[i].weight;
        if (currentSum >= pickPoint) {
          chosenIndex = i;
          break;
        }
      }

      selected.push(remaining.splice(chosenIndex, 1)[0]);
    }

    return selected;
  }

  /**
   * Allocates totalPool into decreasing shares for rank 1..count.
   * e.g., rank 1 gets 40%, rank 2 gets 25%, rank 3 gets 15%, rank 4-7 split remaining 20%.
   */
  private allocatePoolShares(totalPool: bigint, count: number): bigint[] {
    if (count === 1) return [totalPool];

    // Standard distribution ratios: 40%, 25%, 15%, 10%, 10% (for 5 winners)
    const baseRatios = [40, 25, 15, 10, 10, 5, 5];
    const ratios = baseRatios.slice(0, count);
    const sumRatio = ratios.reduce((a, b) => a + b, 0);

    const shares: bigint[] = [];
    let allocatedSum = BigInt(0);

    for (let i = 0; i < count - 1; i++) {
      const share = (totalPool * BigInt(ratios[i])) / BigInt(sumRatio);
      shares.push(share);
      allocatedSum += share;
    }

    // Remainder to last winner
    shares.push(totalPool - allocatedSum);

    return shares;
  }
}
