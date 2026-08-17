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
 * A scope matches on the id at its own level — a region scope on `regionId`, a
 * state scope on `stateId` — so an Official sees their state and not the whole
 * country around it.
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
        // Migration bridge — see the class comment.
        if (this.countryBridgeEnabled && scope.countryId) {
          push({ stateId: null, countryId: scope.countryId });
        }
      } else if (scope.scopeType === 'REGION' && scope.regionId) {
        push({ regionId: scope.regionId });
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
            : scope.scopeType === 'REGION'
              ? scope.regionId
              : null;
      if (targetId) predicates.push({ scopeType: scope.scopeType, targetId });
    }

    return { isUnrestricted: false, predicates };
  }

  /**
   * Asserts that a moderator is authorized to operate in the given target region.
   * Throws ForbiddenException if the target region is outside the moderator's assigned scope.
   *
   * Matching is hierarchical, not exact-only: a STATE-scope clause covers every
   * region inside that state and a COUNTRY-scope clause every region inside that
   * country. `userScopeFilter` already emits `stateId`/`countryId` clauses for
   * STATE/COUNTRY-scoped actors, and an Official who owns a whole state must be
   * able to act anywhere in it — not only where an exact REGION-level RoleScope
   * row happens to exist.
   */
  async assertModeratorInScope(moderatorId: string, regionId: string | null): Promise<void> {
    if (!regionId) return; // Target has no region specified — permit (safety valve)
    if (await this.isUnrestricted(moderatorId)) return;

    const filter = await this.userScopeFilter(moderatorId);
    // If filter is empty object {}, user is unrestricted
    if (!('OR' in filter)) return;

    const clauses = filter.OR;
    // Exact region-level match — the cheap path, no extra query.
    if (clauses.some((clause) => clause.regionId === regionId)) return;

    // No exact region match — a STATE/COUNTRY-scoped clause still covers this
    // region if the region actually sits within that state/country.
    const hasHierarchicalClause = clauses.some(
      (clause) => 'stateId' in clause || 'countryId' in clause,
    );
    if (hasHierarchicalClause) {
      const region = await this.prisma.region.findUnique({
        where: { id: regionId },
        select: { stateId: true, state: { select: { countryId: true } } },
      });
      if (region) {
        // `clause.stateId &&` deliberately skips the migration-bridge clause
        // (`{ stateId: null, countryId }`) for state-matching while still
        // letting its countryId match — see `userScopeFilter`.
        const isHierarchicallyMatched = clauses.some(
          (clause) =>
            (clause.stateId && clause.stateId === region.stateId) ||
            (clause.countryId && clause.countryId === region.state.countryId),
        );
        if (isHierarchicallyMatched) return;
      }
    }

    this.logger.warn(
      `Moderator ${moderatorId} attempted operation outside assigned region scope (target region: ${regionId})`,
    );
    throw new ForbiddenException('You are not authorized to perform moderation in this region.');
  }

  /**
   * Who a Moderator's escalation should notify, by severity: HIGH reaches the
   * Official(s) covering the target region, CRITICAL reaches the Country
   * Manager(s) covering the target region's country, EMERGENCY reaches every
   * Admin directly — reusing the same OFFICIAL → MANAGER → ADMIN chain role
   * requests already climb, rather than inventing a second routing table.
   *
   * Callers only ever have a regionId on hand (that's what every room/stream
   * model stores) — country is derived here via Region → State → Country so
   * CRITICAL doesn't need a second geography lookup at every call site.
   *
   * A GLOBAL scope always matches, same as everywhere else in this class. If
   * no one is scoped to the territory (an unstaffed region), this falls back
   * to Admin rather than silently dropping a critical escalation.
   */
  async resolveEscalationRecipients(
    severity: EscalationSeverity,
    regionId: string | null | undefined,
  ): Promise<string[]> {
    if (severity === 'EMERGENCY') {
      return this.roles.getUserIdsWithAnyRole(['ADMIN', 'SUPER_ADMIN']);
    }

    const roleName = ESCALATION_ROLE[severity];
    const scopeClauses: Array<Record<string, unknown>> = [{ scopeType: 'GLOBAL' }];
    if (severity === 'HIGH' && regionId) {
      scopeClauses.push({ scopeType: 'REGION', regionId });
    } else if (severity === 'CRITICAL' && regionId) {
      const region = await this.prisma.region.findUnique({
        where: { id: regionId },
        select: { state: { select: { countryId: true } } },
      });
      if (region?.state.countryId) {
        scopeClauses.push({ scopeType: 'COUNTRY', countryId: region.state.countryId });
      }
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
        `No ${roleName} scoped to escalation target (region=${regionId ?? 'n/a'}) — falling back to Admin.`,
      );
      return this.roles.getUserIdsWithAnyRole(['ADMIN', 'SUPER_ADMIN']);
    }
    return userIds;
  }

  /**
   * Moderators who cover the given region: a GLOBAL scope always matches,
   * plus anyone with a REGION scope on `regionId`. Unlike
   * `resolveEscalationRecipients`, this has no Admin fallback — an
   * unstaffed region just means nobody gets paged, which is correct for a
   * routine per-report notification rather than an escalation.
   */
  async resolveModeratorsInScope(regionId: string | null | undefined): Promise<string[]> {
    const scopeClauses: Array<Record<string, unknown>> = [{ scopeType: 'GLOBAL' }];
    if (regionId) scopeClauses.push({ scopeType: 'REGION', regionId });

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
