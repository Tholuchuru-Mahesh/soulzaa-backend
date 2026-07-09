/**
 * Wallet module constants. The per-user lock key serialises every balance
 * mutation for a wallet so concurrent debits/credits can never race (combined
 * with the DB transaction + idempotency key, this makes movements exactly-once).
 */

/** Lock guarding all balance mutations for a single wallet. */
export function walletLockKey(userId: string): string {
  return `wallet:lock:${userId}`;
}
