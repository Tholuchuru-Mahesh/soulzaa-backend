import { Injectable, Logger } from '@nestjs/common';
import { ScopeType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuthorizationCacheService } from './authorization-cache.service';

export interface UserScopeDetail {
  userRoleId: string;
  roleName: string;
  scopeType: ScopeType;
  countryId?: string | null;
  countryCode?: string | null;
  stateId?: string | null;
  stateCode?: string | null;
  stateName?: string | null;
  /** System-generated `{countryCode}-S-{sequence}` id, e.g. "IN-S-04" — the
   *  moderator-facing "Region ID" (`State.moderatorRegionCode`). Distinct
   *  from `stateCode`, which is admin-typed and used for RBAC matching. */
  moderatorRegionCode?: string | null;
  /** Still populated for non-Moderator roles (Officials, role-request routing)
   *  that continue to use REGION-level scope; Moderators stop at State. */
  regionId?: string | null;
  regionCode?: string | null;
}

export interface ScopeContext {
  countryCode?: string;
  stateCode?: string;
  regionCode?: string;
}

@Injectable()
export class GeographicScopeResolver {
  private readonly logger = new Logger(GeographicScopeResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: AuthorizationCacheService,
  ) {}

  /**
   * Resolves all active geographic scope assignments for a given user with Redis caching.
   */
  async getUserScopes(userId: string): Promise<UserScopeDetail[]> {
    const cached = await this.cacheService.getCachedScopes<UserScopeDetail>(userId);
    if (cached !== null) {
      return cached;
    }

    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: {
        role: true,
        roleScopes: {
          include: {
            country: true,
            state: true,
            region: true,
          },
        },
      },
    });

    const scopes: UserScopeDetail[] = [];

    for (const ur of userRoles) {
      for (const scope of ur.roleScopes) {
        scopes.push({
          userRoleId: ur.id,
          roleName: ur.role.name,
          scopeType: scope.scopeType,
          countryId: scope.countryId,
          countryCode: scope.country?.code,
          stateId: scope.stateId,
          stateCode: scope.state?.code,
          stateName: scope.state?.name,
          moderatorRegionCode: scope.state?.moderatorRegionCode,
          regionId: scope.regionId,
          regionCode: scope.region?.code,
        });
      }
    }

    await this.cacheService.setCachedScopes(userId, scopes);
    return scopes;
  }

  /**
   * Infrastructure utility to check if a user's assigned scopes authorize access within a given target context.
   */
  async isWithinScope(userId: string, context: ScopeContext): Promise<boolean> {
    const userScopes = await this.getUserScopes(userId);

    if (userScopes.length === 0) {
      return true;
    }

    for (const scope of userScopes) {
      if (scope.scopeType === ScopeType.GLOBAL) {
        return true;
      }

      if (scope.scopeType === ScopeType.COUNTRY) {
        if (context.countryCode && scope.countryCode === context.countryCode) {
          return true;
        }
      }

      if (scope.scopeType === ScopeType.STATE) {
        if (
          context.countryCode &&
          scope.countryCode === context.countryCode &&
          context.stateCode &&
          scope.stateCode === context.stateCode
        ) {
          return true;
        }
      }

      if (scope.scopeType === ScopeType.REGION) {
        if (
          context.countryCode &&
          scope.countryCode === context.countryCode &&
          context.stateCode &&
          scope.stateCode === context.stateCode &&
          context.regionCode &&
          scope.regionCode === context.regionCode
        ) {
          return true;
        }
      }
    }

    return false;
  }
}
