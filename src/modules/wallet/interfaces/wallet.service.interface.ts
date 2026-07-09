import type { WalletCurrency, WalletTxnReason } from '@prisma/client';

/**
 * Public contract for the wallet module — the ONLY surface other modules
 * (gifts, VIP, treasure boxes, games, payments) may depend on, alongside the
 * EVENT_BUS. Internals (entities, repositories, concrete service) stay private.
 * The wallet is the economy authority: balances never go negative and every
 * movement is an immutable, idempotent ledger entry.
 */
export const WALLET_SERVICE = Symbol('WALLET_SERVICE');

/** Snapshot of a wallet's three balances (Number-safe read model). */
export interface WalletBalances {
  gold: number;
  free: number;
  earnings: number;
}

/** A single balance movement request. `idempotencyKey` makes it exactly-once. */
export interface WalletMovementInput {
  userId: string;
  currency: WalletCurrency;
  /** Positive integer amount of coins to move. */
  amount: number;
  reason: WalletTxnReason;
  /** Globally-unique key; a replay returns the original result, no re-apply. */
  idempotencyKey: string;
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
  /** Actor that caused the movement (defaults to `userId`). */
  actorId?: string;
}

/** Result of a debit/credit. `duplicate` true ⇒ an idempotent replay. */
export interface WalletMovementResult {
  transactionId: string;
  currency: WalletCurrency;
  balanceAfter: number;
  duplicate: boolean;
}

export interface IWalletService {
  /** Create the wallet row if absent (idempotent). */
  ensureWallet(userId: string): Promise<void>;

  /** Current balances (zeroed view if the wallet does not exist yet). */
  getBalance(userId: string): Promise<WalletBalances>;

  /**
   * Deduct `amount` of `currency`. Throws INSUFFICIENT_BALANCE if the balance
   * would go negative. Idempotent on `idempotencyKey`.
   */
  debit(input: WalletMovementInput): Promise<WalletMovementResult>;

  /** Add `amount` of `currency`. Idempotent on `idempotencyKey`. */
  credit(input: WalletMovementInput): Promise<WalletMovementResult>;
}
