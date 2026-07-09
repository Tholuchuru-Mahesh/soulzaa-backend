import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WalletCurrency, WalletTxnReason } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { WALLET_EVENTS, type WalletCreditedEvent } from 'src/modules/wallet/events/wallet.events';
import { VipService } from '../services/vip.service';

/**
 * Drives VIP progress from Gold-coin recharges. Subscribes to the wallet's
 * credited event and, for RECHARGE credits of GOLD, adds the amount to the
 * user's lifetime recharge (idempotent on the wallet transaction id) — which
 * auto-upgrades the tier. Best-effort; a failure never affects the recharge.
 */
@Injectable()
export class VipRechargeListener implements OnModuleInit {
  private readonly logger = new Logger(VipRechargeListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly vip: VipService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<WalletCreditedEvent>(WALLET_EVENTS.CREDITED, (e) => {
      const p = e.payload;
      if (p.reason !== WalletTxnReason.RECHARGE || p.currency !== WalletCurrency.GOLD) return;
      if (p.amount <= 0) return;
      void this.vip
        .recordRecharge({
          userId: p.userId,
          amount: p.amount,
          idempotencyKey: `recharge:${p.transactionId}`,
        })
        .catch((err) => this.logger.warn(`VIP recharge accrual failed: ${(err as Error).message}`));
    });
  }
}
