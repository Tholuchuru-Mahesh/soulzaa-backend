/**
 * Port for reading a user's effective platform roles.
 *
 * The common layer cannot import domain modules, so guards depend on this
 * contract and the authorization module supplies the implementation (its
 * RoleResolver, which reads the RBAC UserRole store through a Redis cache).
 *
 * This exists so role checks have exactly one source of truth. Reading roles
 * off the JWT claim instead would re-open the drift this replaced: a token
 * minted before a promotion or revocation would keep deciding access.
 */
export interface IRoleSource {
  /** Effective role names for a user, including roles inherited via hierarchy. */
  getRoleNames(userId: string): Promise<string[]>;
  /**
   * Reverse lookup: every user holding at least one of these roles. Directly
   * assigned only — a reconciliation job wants the accounts that *were granted*
   * a role, not everyone who inherits its permissions.
   */
  getUserIdsWithAnyRole(roleNames: string[]): Promise<string[]>;
}

export const ROLE_SOURCE = Symbol('ROLE_SOURCE');
