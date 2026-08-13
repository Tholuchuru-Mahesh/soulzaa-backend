import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeographicScopeResolver } from 'src/modules/authorization/services/geographic-scope-resolver.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';

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
   */
  async assertModeratorInScope(moderatorId: string, regionId: string | null): Promise<void> {
    if (!regionId) return; // Target has no region specified — permit (safety valve)
    if (await this.isUnrestricted(moderatorId)) return;

    const filter = await this.userScopeFilter(moderatorId);
    // If filter is empty object {}, user is unrestricted
    if (!('OR' in filter)) return;

    // Check if any OR clause in filter matches regionId
    const clauses = filter.OR;
    const isMatched = clauses.some((clause) => clause.regionId === regionId);

    if (!isMatched) {
      this.logger.warn(
        `Moderator ${moderatorId} attempted operation outside assigned region scope (target region: ${regionId})`,
      );
      throw new ForbiddenException(
        'You are not authorized to perform moderation in this region.',
      );
    }
  }
}
