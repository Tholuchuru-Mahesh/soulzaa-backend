import type { WalletCurrency, WalletTxnReason } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * Wallet domain events on the EVENT_BUS. Other modules (analytics, notifications,
 * VIP progress from recharge) subscribe without importing wallet internals.
 */
export const WALLET_EVENTS = {
  DEBITED: 'wallet.debited',
  CREDITED: 'wallet.credited',
} as const;

export interface WalletMovementPayload {
  userId: string;
  transactionId: string;
  currency: WalletCurrency;
  amount: number;
  balanceAfter: number;
  reason: WalletTxnReason;
  referenceType: string | null;
  referenceId: string | null;
}

export class WalletDebitedEvent extends DomainEvent<WalletMovementPayload> {
  readonly name = WALLET_EVENTS.DEBITED;
}

export class WalletCreditedEvent extends DomainEvent<WalletMovementPayload> {
  readonly name = WALLET_EVENTS.CREDITED;
}
