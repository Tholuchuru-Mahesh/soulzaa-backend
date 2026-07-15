import { Inject, Injectable } from '@nestjs/common';
import {
  BackpackItemSource,
  BackpackItemType,
  TreasureRewardKind,
  WalletCurrency,
  WalletTxnReason,
} from '@prisma/client';
import {
  BACKPACK_SERVICE,
  type IBackpackService,
} from 'src/modules/backpack/interfaces/backpack.service.interface';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import type { RewardEntry } from '../constants/treasure.constants';

/** A contributor eligible for a ranked reward. */
export interface RankedRecipient {
  rank: number;
  userId: string;
}

/** A reward that was actually distributed (for the immutable ledger + broadcast). */
export interface DistributedReward {
  userId: string;
  rank: number;
  kind: TreasureRewardKind;
  coins: bigint | null;
  itemType: string | null;
  itemName: string | null;
  walletTxnId: string | null;
  backpackItemId: string | null;
}

/**
 * Distributes a reward list to ranked recipients: COINS credit the wallet
 * (idempotent), BACKPACK_ITEM grants a backpack item (idempotent). The
 * `idempotencyPrefix` (a box-open / rocket-completion id) makes the whole
 * distribution safe to re-run — a replay maps to the same wallet/backpack rows.
 * Shared by treasure boxes and rocket events.
 */
@Injectable()
export class RewardDistributor {
  constructor(
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
    @Inject(BACKPACK_SERVICE) private readonly backpack: IBackpackService,
  ) {}

  async distribute(
    input: {
      recipients: RankedRecipient[];
      rewards: RewardEntry[];
      idempotencyPrefix: string;
      walletReason: WalletTxnReason;
      backpackSource: BackpackItemSource;
      referenceType: string;
      referenceId: string;
    },
    tx?: any,
  ): Promise<DistributedReward[]> {
    const byRank = new Map(input.recipients.map((r) => [r.rank, r.userId]));
    const distributed: DistributedReward[] = [];

    for (const reward of input.rewards) {
      const userId = byRank.get(reward.rank);
      if (!userId) continue; // no contributor at this rank → reward unclaimed

      if (reward.kind === 'COINS' && reward.coins && reward.coins > 0) {
        const res = await this.wallet.credit({
          userId,
          currency: WalletCurrency.GOLD,
          amount: reward.coins,
          reason: input.walletReason,
          idempotencyKey: `${input.idempotencyPrefix}:r${reward.rank}:coins`,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
        }, tx);
        distributed.push({
          userId,
          rank: reward.rank,
          kind: TreasureRewardKind.COINS,
          coins: BigInt(reward.coins),
          itemType: null,
          itemName: null,
          walletTxnId: res.transactionId,
          backpackItemId: null,
        });
      } else if (reward.kind === 'BACKPACK_ITEM' && reward.itemType && reward.itemName) {
        const res = await this.backpack.grant({
          userId,
          type: reward.itemType as BackpackItemType,
          name: reward.itemName,
          source: input.backpackSource,
          refId: reward.itemRefId,
          transferable: reward.transferable ?? false,
          grantKey: `${input.idempotencyPrefix}:r${reward.rank}:item`,
          metadata: { referenceType: input.referenceType, referenceId: input.referenceId },
        }, tx);
        distributed.push({
          userId,
          rank: reward.rank,
          kind: TreasureRewardKind.BACKPACK_ITEM,
          coins: null,
          itemType: reward.itemType,
          itemName: reward.itemName,
          walletTxnId: null,
          backpackItemId: res.itemId,
        });
      }
    }
    return distributed;
  }
}
