/**
 * Wallet module constants. The per-user lock key serialises every balance
 * mutation for a wallet so concurrent debits/credits can never race (combined
 * with the DB transaction + idempotency key, this makes movements exactly-once).
 */

/** Lock guarding all balance mutations for a single wallet. */
export function walletLockKey(userId: string): string {
  return `wallet:lock:${userId}`;
}

// ---- VR-14: realtime + reconciliation ----

/** Personal, user-scoped wallet socket events (pushed via emitToUserEverywhere). */
export const WALLET_SOCKET_EVENTS = {
  WALLET_UPDATED: 'walletUpdated',
  BALANCE_CHANGED: 'balanceChanged',
  TRANSACTION_CREATED: 'transactionCreated',
  TRANSACTION_COMPLETED: 'transactionCompleted',
} as const;

/** BullMQ job names on the existing `wallet-processing` queue. */
export const WALLET_JOBS = {
  RECONCILE_SWEEP: 'wallet.reconcile.sweep',
} as const;

/**
 * Per-user coalescing window for balance broadcasts. During a burst (multi-target
 * gift, rapid combos) only the latest balance snapshot per user is emitted when
 * the window elapses. Correctness-preserving: last-writer-wins on balanceAfter.
 */
export const WALLET_COALESCE_WINDOW_MS = 75;

/** Distributed-lock key for the fleet-wide reconciliation sweep. */
export const WALLET_RECONCILE_LOCK_KEY = 'wallet:reconcile:sweep';

/** Page size for the fleet-wide reconciliation sweep's cursor scan. */
export const WALLET_RECONCILE_BATCH_SIZE = 500;
