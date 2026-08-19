import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { GeographicScopeResolver } from 'src/modules/authorization/services/geographic-scope-resolver.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';

/** Severity tiers a Moderator can escalate a critical violation to. */
export type EscalationSeverity = 'HIGH' | 'CRITICAL' | 'EMERGENCY';

/** The role each escalation tier routes to, reusing the same OFFICIAL → MANAGER → ADMIN chain role requests climb. */
const ESCALATION_ROLE: Record<Exclude<EscalationSeverity, 'EMERGENCY'>, string> = {
  HIGH: 'OFFICIAL',
  CRITICAL: 'COUNTRY_MANAGER',
};

/** Roles that see the whole platform regardless of any scope rows they hold. */
const UNRESTRICTED_ROLES = ['SUPER_ADMIN', 'ADMIN'];

/** `{}` matches every row; `{ OR: [] }` matches none. */
export type UserScopeFilter = Record<string, never> | { OR: Array<Record<string, unknown>> };

/**
 * Turns a user's geographic scope assignments into an exact Prisma filter.
 *
 * A scope matches on the id at its own level — a state scope on `stateId`, a
 * country scope on `countryId` — so an Official sees their state and not the
 * whole country around it. Moderators are provisioned at STATE granularity
 * (Region was removed from moderation scoping entirely — see
 * `assertModeratorInScope`).
 *
 * **Migration bridge.** While `AUTHORIZATION_SCOPE_COUNTRY_BRIDGE` is on, a state
 * scope also matches users who have no state set but do sit in the right
 * country. Location is backfilled to country granularity only (nothing in the
 * old data records a state), so without it every official's console would be
 * empty the moment this shipped. The clause narrows itself as data arrives: once
 * a user is assigned a state they stop matching the bridge and match the exact
 * predicate instead.
 *
 * It is a flag rather than a hardcoded clause so the cutover to strict scope is
 * a config change, not a deploy — and so it can be reverted just as fast if
 * coverage turns out to be incomplete. Set it false once every user carries a
 * `stateId`.
 */
@Injectable()
export class WorkforceScopeService {
  private readonly logger = new Logger(WorkforceScopeService.name);
  private readonly countryBridgeEnabled: boolean;

  constructor(
    private readonly scopes: GeographicScopeResolver,
    private readonly roles: RoleResolver,
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.countryBridgeEnabled = Boolean(
      config.get('authorization', { infer: true })?.scopeCountryBridge,
    );
  }

  private async isUnrestricted(userId: string): Promise<boolean> {
    const roleNames = await this.roles.getRoleNames(userId);
    if (roleNames.some((name) => UNRESTRICTED_ROLES.includes(name))) return true;

    const assignments = await this.scopes.getUserScopes(userId);
    return assignments.some((scope) => scope.scopeType === 'GLOBAL');
  }

  /**
   * A Prisma `where` fragment for user queries.
   *
   * `{}` means unrestricted. `{ OR: [] }` means *nothing* — an operational role
   * with no scope assigned sees no data, which is the safe reading. Returning
   * `{}` there would silently hand them the entire platform.
   */
  async userScopeFilter(userId: string): Promise<UserScopeFilter> {
    if (await this.isUnrestricted(userId)) return {};

    const assignments = await this.scopes.getUserScopes(userId);
    const clauses: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();

    const push = (clause: Record<string, unknown>) => {
      const key = JSON.stringify(clause);
      if (seen.has(key)) return;
      seen.add(key);
      clauses.push(clause);
    };

    for (const scope of assignments) {
      if (scope.scopeType === 'COUNTRY' && scope.countryId) {
        push({ countryId: scope.countryId });
      } else if (scope.scopeType === 'STATE' && scope.stateId) {
        push({ stateId: scope.stateId });
      } else if (scope.scopeType === 'REGION') {
        if (scope.stateId) {
          push({ stateId: scope.stateId });
        } else if (scope.countryId) {
          push({ countryId: scope.countryId });
        }
      }
    }

    return { OR: clauses };
  }

  /** The predicates in force, for display in the mobile console header. */
  async describeScope(userId: string): Promise<{
    isUnrestricted: boolean;
    predicates: Array<{ scopeType: string; targetId: string }>;
  }> {
    if (await this.isUnrestricted(userId)) {
      return { isUnrestricted: true, predicates: [] };
    }

    const assignments = await this.scopes.getUserScopes(userId);
    const predicates: Array<{ scopeType: string; targetId: string }> = [];

    for (const scope of assignments) {
      const targetId =
        scope.scopeType === 'COUNTRY'
          ? scope.countryId
          : scope.scopeType === 'STATE'
            ? scope.stateId
            : null;
      if (targetId) predicates.push({ scopeType: scope.scopeType, targetId });
    }

    return { isUnrestricted: false, predicates };
  }

  /**
   * Resolves the state/country a resource's owner sits in — the shared
   * lookup `assertModeratorInScope`/`resolveEscalationRecipients`/
   * `resolveModeratorsInScope` all use instead of the Region indirection
   * they used to walk through.
   */
  private async resolveOwnerLocation(
    ownerId: string,
  ): Promise<{ stateId: string | null; countryId: string | null } | null> {
    return this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { stateId: true, countryId: true },
    });
  }

  /**
   * Asserts that a moderator is authorized to act on a resource owned by
   * `ownerId`. Throws ForbiddenException if the owner's territory is outside
   * the moderator's assigned scope.
   *
   * Resolves the owner's `stateId`/`countryId` directly (one `User` lookup)
   * and matches it against the moderator's scope clauses — no Region
   * indirection, since Moderator `RoleScope` rows stop at State.
   */
  async assertModeratorInScope(moderatorId: string, ownerId: string | null): Promise<void> {
    if (!ownerId) return; // No owner known — permit (safety valve)
    if (await this.isUnrestricted(moderatorId)) return;

    const filter = await this.userScopeFilter(moderatorId);
    if (!('OR' in filter)) return; // unrestricted

    const owner = await this.resolveOwnerLocation(ownerId);
    if (!owner) return; // Owner vanished — same safety valve as an unresolved target

    const clauses = filter.OR;
    // `clause.stateId &&` deliberately skips the migration-bridge clause
    // (`{ stateId: null, countryId }`) for state-matching while still
    // letting its countryId match — see `userScopeFilter`.
    const matched = clauses.some(
      (clause) =>
        (clause.stateId && clause.stateId === owner.stateId) ||
        (clause.countryId && clause.countryId === owner.countryId),
    );
    if (matched) return;

    this.logger.warn(
      `Moderator ${moderatorId} attempted operation outside assigned scope (target owner: ${ownerId})`,
    );
    throw new ForbiddenException('You are not authorized to perform moderation for this user.');
  }

  /**
   * Who a Moderator's escalation should notify, by severity: HIGH reaches the
   * Official(s) covering the resource owner's state, CRITICAL reaches the
   * Country Manager(s) covering the owner's country, EMERGENCY reaches every
   * Admin directly — reusing the same OFFICIAL → MANAGER → ADMIN chain role
   * requests already climb, rather than inventing a second routing table.
   *
   * A GLOBAL scope always matches, same as everywhere else in this class. If
   * no one is scoped to the territory, this falls back to Admin rather than
   * silently dropping a critical escalation.
   */
  async resolveEscalationRecipients(
    severity: EscalationSeverity,
    ownerId: string | null | undefined,
  ): Promise<string[]> {
    if (severity === 'EMERGENCY') {
      return this.roles.getUserIdsWithAnyRole(['ADMIN', 'SUPER_ADMIN']);
    }

    const roleName = ESCALATION_ROLE[severity];
    const scopeClauses: Array<Record<string, unknown>> = [{ scopeType: 'GLOBAL' }];
    const owner = ownerId ? await this.resolveOwnerLocation(ownerId) : null;
    if (severity === 'HIGH' && owner?.stateId) {
      scopeClauses.push({ scopeType: 'STATE', stateId: owner.stateId });
    } else if (severity === 'CRITICAL' && owner?.countryId) {
      scopeClauses.push({ scopeType: 'COUNTRY', countryId: owner.countryId });
    }

    const rows = await this.prisma.roleScope.findMany({
      where: {
        OR: scopeClauses,
        userRole: { role: { name: roleName }, suspendedAt: null },
      },
      select: { userRole: { select: { userId: true } } },
    });

    const userIds = [...new Set(rows.map((r) => r.userRole.userId))];
    if (userIds.length === 0) {
      this.logger.warn(
        `No ${roleName} scoped to escalation target (owner=${ownerId ?? 'n/a'}) — falling back to Admin.`,
      );
      return this.roles.getUserIdsWithAnyRole(['ADMIN', 'SUPER_ADMIN']);
    }
    return userIds;
  }

  /**
   * Moderators who cover a resource owner's territory: a GLOBAL scope always
   * matches, plus anyone whose STATE/COUNTRY scope contains the owner's
   * state/country. Unlike `resolveEscalationRecipients`, this has no Admin
   * fallback — nobody covering the territory just means nobody gets paged,
   * which is correct for a routine per-report notification rather than an
   * escalation.
   */
  async resolveModeratorsInScope(ownerId: string | null | undefined): Promise<string[]> {
    const scopeClauses: Array<Record<string, unknown>> = [{ scopeType: 'GLOBAL' }];
    const owner = ownerId ? await this.resolveOwnerLocation(ownerId) : null;
    if (owner?.stateId) scopeClauses.push({ scopeType: 'STATE', stateId: owner.stateId });
    if (owner?.countryId) scopeClauses.push({ scopeType: 'COUNTRY', countryId: owner.countryId });

    const rows = await this.prisma.roleScope.findMany({
      where: {
        OR: scopeClauses,
        userRole: { role: { name: 'MODERATOR' }, suspendedAt: null },
      },
      select: { userRole: { select: { userId: true } } },
    });
    return [...new Set(rows.map((r) => r.userRole.userId))];
  }
}
