// src/modules/wallet/listeners/wallet-realtime.listener.ts
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WalletEntryType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { WALLET_COALESCE_WINDOW_MS, WALLET_SOCKET_EVENTS } from '../constants/wallet.constants';
import {
  WALLET_EVENTS,
  type WalletCreditedEvent,
  type WalletDebitedEvent,
  type WalletMovementPayload,
} from '../events/wallet.events';
import { WalletMetrics } from '../metrics/wallet.metrics';
import { WalletService } from '../services/wallet.service';

/**
 * Bridges wallet domain events to the affected user's sockets everywhere (VR-14).
 *
 * Per-transaction signals (transactionCreated/Completed) fire immediately — each
 * is a distinct, meaningful event. Balance snapshots (balanceChanged/walletUpdated)
 * are coalesced per user over a short window so a burst (multi-target gift, rapid
 * combos) collapses to one broadcast carrying the LATEST balance. Correctness is
 * unaffected: the ledger is the source of truth; this only trims redundant pushes.
 *
 * `transactionCreated` and `transactionCompleted` are aliases of the same atomic
 * commit today (there is no async pending state); they stay separate names for
 * forward compatibility with future queued wallet workflows.
 */
@Injectable()
export class WalletRealtimeListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WalletRealtimeListener.name);
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
    private readonly wallet: WalletService,
    private readonly metrics: WalletMetrics,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<WalletDebitedEvent>(WALLET_EVENTS.DEBITED, (e) =>
      this.onMovement(WalletEntryType.DEBIT, e.payload),
    );
    this.bus.subscribe<WalletCreditedEvent>(WALLET_EVENTS.CREDITED, (e) =>
      this.onMovement(WalletEntryType.CREDIT, e.payload),
    );
  }

  onModuleDestroy(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  private async onMovement(type: WalletEntryType, p: WalletMovementPayload): Promise<void> {
    // Metrics (duration is ~0 here — this is the observe path, not the commit).
    this.metrics.recordMovement(p.reason, type, p.currency, 0);

    // Per-transaction events: immediate, never coalesced.
    const txnPayload = {
      transactionId: p.transactionId,
      reason: p.reason,
      type,
      amount: p.amount,
      currency: p.currency,
    };
    this.sockets.emitToUserEverywhere(
      p.userId,
      WALLET_SOCKET_EVENTS.TRANSACTION_CREATED,
      txnPayload,
    );
    this.sockets.emitToUserEverywhere(
      p.userId,
      WALLET_SOCKET_EVENTS.TRANSACTION_COMPLETED,
      txnPayload,
    );

    // Balance snapshot: coalesced per user.
    this.scheduleBalanceFlush(p.userId);
  }

  private scheduleBalanceFlush(userId: string): void {
    const existing = this.pending.get(userId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      void this.flush(userId);
    }, WALLET_COALESCE_WINDOW_MS);
    this.pending.set(userId, timer);
  }

  /** Broadcast the user's current balances now, clearing any pending window. */
  async flush(userId: string): Promise<void> {
    const timer = this.pending.get(userId);
    if (timer) clearTimeout(timer);
    this.pending.delete(userId);
    try {
      const balances = await this.wallet.getBalance(userId);
      this.sockets.emitToUserEverywhere(userId, WALLET_SOCKET_EVENTS.BALANCE_CHANGED, { balances });
      this.sockets.emitToUserEverywhere(userId, WALLET_SOCKET_EVENTS.WALLET_UPDATED, { balances });
    } catch (err) {
      this.logger.warn(`wallet realtime flush failed for ${userId}: ${(err as Error).message}`);
    }
  }
}
