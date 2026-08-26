import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { WalletCurrency, WalletTxnReason } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { WALLET_EVENTS, type WalletDebitedEvent } from 'src/modules/wallet/events/wallet.events';
import { WealthExpLedgerService } from '../services/wealth-exp-ledger.service';

/**
 * Reverses Wealth Level EXP for a refunded/charged-back Gold Coin purchase.
 * Subscribes to the wallet's debited event, filtered to the reversal reason
 * `WalletTransactionService.reverseWallet` exclusively uses
 * (`wallet-transaction.service.ts:333-341`) — the same `referenceId`
 * (purchase order id) the original award was keyed to lets the ledger cap
 * the reversal at whatever EXP is still outstanding for that purchase.
 */
@Injectable()
export class WealthExpReversalListener implements OnModuleInit {
  private readonly logger = new Logger(WealthExpReversalListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly ledger: WealthExpLedgerService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<WalletDebitedEvent>(WALLET_EVENTS.DEBITED, (e) => {
      const p = e.payload;
      if (p.reason !== WalletTxnReason.PURCHASE_REVERSAL || p.currency !== WalletCurrency.GOLD) return;
      if (p.amount <= 0) return;
      void this.ledger
        .reverse({
          userId: p.userId,
          sourceRef: p.referenceId ?? p.transactionId,
          amount: p.amount,
          idempotencyKey: `wealth-exp-reversal:${p.transactionId}`,
        })
        .catch((err) => this.logger.warn(`Wealth EXP reversal failed: ${(err as Error).message}`));
    });
  }
}
