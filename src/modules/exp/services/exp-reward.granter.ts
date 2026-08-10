import { Inject, Injectable } from '@nestjs/common';
import { BackpackItemSource, WalletCurrency, WalletTxnReason } from '@prisma/client';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import type { RewardEntry } from '../constants/exp.constants';
import type { LevelRewardSummary } from '../events/exp.events';

/**
 * Grants level-up rewards: COINS credit the wallet (GOLD or GAME, idempotent),
 * COSMETIC grants a catalog cosmetic into the backpack (via COSMETICS_SERVICE).
 * Keyed by an idempotency prefix (the user+level) so a replayed level-up maps to
 * the same wallet/backpack rows.
 */
@Injectable()
export class ExpRewardGranter {
  constructor(
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
    @Inject(COSMETICS_SERVICE) private readonly cosmetics: ICosmeticsService,
  ) {}

  async grant(
    userId: string,
    rewards: RewardEntry[],
    idempotencyPrefix: string,
  ): Promise<LevelRewardSummary[]> {
    const summaries: LevelRewardSummary[] = [];
    let i = 0;
    for (const reward of rewards) {
      i += 1;
      if (reward.kind === 'COINS' && reward.coins && reward.coins > 0) {
        const currency = reward.currency === 'GOLD' ? WalletCurrency.GOLD : WalletCurrency.GAME;
        await this.wallet.credit({
          userId,
          currency,
          amount: reward.coins,
          reason: WalletTxnReason.EVENT_REWARD,
          idempotencyKey: `${idempotencyPrefix}:coins:${i}`,
          referenceType: 'level_reward',
        });
        summaries.push({
          kind: 'COINS',
          coins: reward.coins,
          currency,
          cosmeticId: null,
        });
      } else if (reward.kind === 'COSMETIC' && reward.cosmeticId) {
        const res = await this.cosmetics.grantToUser({
          userId,
          cosmeticId: reward.cosmeticId,
          source: BackpackItemSource.EVENT,
          grantKey: `${idempotencyPrefix}:cosmetic:${reward.cosmeticId}`,
        });
        if (res) {
          summaries.push({
            kind: 'COSMETIC',
            coins: null,
            currency: null,
            cosmeticId: reward.cosmeticId,
          });
        }
      }
    }
    return summaries;
  }
}
