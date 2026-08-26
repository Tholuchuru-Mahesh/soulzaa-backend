import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { WalletCurrency, WalletTxnReason } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { WALLET_EVENTS, type WalletCreditedEvent } from 'src/modules/wallet/events/wallet.events';
import { WealthExpLedgerService } from '../services/wealth-exp-ledger.service';

/**
 * Drives Wealth Level EXP from Gold Coin purchases. Subscribes to the same
 * wallet-credited event the legacy VIP module used
 * (`vip-recharge.listener.ts`) — for RECHARGE credits of GOLD, awards EXP
 * equal to the full credited amount (paid + bonus coins are already merged
 * into one credit by `ReceiptVerificationService`, see
 * `receipt-verification.service.ts:270-283`), idempotent on the wallet
 * transaction id. Best-effort; a failure here never affects the purchase or
 * the wallet credit that already landed.
 */
@Injectable()
export class WealthExpListener implements OnModuleInit {
  private readonly logger = new Logger(WealthExpListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly ledger: WealthExpLedgerService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<WalletCreditedEvent>(WALLET_EVENTS.CREDITED, (e) => {
      const p = e.payload;
      if (p.reason !== WalletTxnReason.RECHARGE || p.currency !== WalletCurrency.GOLD) return;
      if (p.amount <= 0) return;
      void this.ledger
        .award({
          userId: p.userId,
          amount: p.amount,
          sourceRef: p.referenceId ?? p.transactionId,
          idempotencyKey: `wealth-exp:${p.transactionId}`,
        })
        .catch((err) => this.logger.warn(`Wealth EXP award failed: ${(err as Error).message}`));
    });
  }
}
