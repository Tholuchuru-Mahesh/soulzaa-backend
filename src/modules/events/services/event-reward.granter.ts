import { Inject, Injectable } from '@nestjs/common';
import { BackpackItemSource, WalletCurrency, WalletTxnReason } from '@prisma/client';
import { ExpSource } from 'src/common/enums/exp-source.enum';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import { EXP_SERVICE, type IExpService } from 'src/modules/exp/interfaces/exp.service.interface';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import type { EventRewardEntry } from '../constants/events.constants';
import type { EventRewardSummary } from '../events/event.events';

/**
 * Grants event-claim rewards: COINS credit the wallet, COSMETIC grants a catalog
 * cosmetic into the backpack, EXP awards experience — all idempotent, keyed by
 * the claim (event+user) so a replay maps to the same rows.
 */
@Injectable()
export class EventRewardGranter {
  constructor(
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
    @Inject(COSMETICS_SERVICE) private readonly cosmetics: ICosmeticsService,
    @Inject(EXP_SERVICE) private readonly exp: IExpService,
  ) {}

  async grant(
    userId: string,
    rewards: EventRewardEntry[],
    idempotencyPrefix: string,
  ): Promise<EventRewardSummary[]> {
    const summaries: EventRewardSummary[] = [];
    let i = 0;
    for (const reward of rewards) {
      i += 1;
      if (reward.kind === 'COINS' && reward.coins && reward.coins > 0) {
        const currency = reward.currency === 'GOLD' ? WalletCurrency.GOLD : WalletCurrency.FREE;
        await this.wallet.credit({
          userId,
          currency,
          amount: reward.coins,
          reason: WalletTxnReason.EVENT_REWARD,
          idempotencyKey: `${idempotencyPrefix}:coins:${i}`,
          referenceType: 'event',
        });
        summaries.push({
          kind: 'COINS',
          coins: reward.coins,
          currency,
          cosmeticId: null,
          exp: null,
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
            exp: null,
          });
        }
      } else if (reward.kind === 'EXP' && reward.exp && reward.exp > 0) {
        await this.exp.award({
          userId,
          amount: reward.exp,
          source: ExpSource.EVENT,
          idempotencyKey: `${idempotencyPrefix}:exp:${i}`,
          referenceType: 'event',
        });
        summaries.push({
          kind: 'EXP',
          coins: null,
          currency: null,
          cosmeticId: null,
          exp: reward.exp,
        });
      }
    }
    return summaries;
  }
}
