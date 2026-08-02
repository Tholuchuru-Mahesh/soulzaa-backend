/**
 * Port for the hidden-staff-account rule.
 *
 * `User.isHiddenAccount` is a denormalised projection of "this account holds a
 * hidden role". This module owns the rule; the users module owns the column.
 * Keeping the two apart is what lets every read path filter on a plain boolean
 * instead of resolving roles per request.
 */
export const ADMIN_IDENTITY_SERVICE = Symbol('ADMIN_IDENTITY_SERVICE');

export interface IAdminIdentityService {
  /** Recomputes and persists the hidden flag from the account's current roles. */
  syncHiddenState(userId: string): Promise<void>;
  isHidden(userId: string): Promise<boolean>;
  /** One-off reconciliation for accounts that predate the flag. */
  backfill(): Promise<{ scanned: number; hidden: number }>;
}
