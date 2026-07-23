import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { GeographicScopeResolver, ScopeContext } from './geographic-scope-resolver.service';
import { PermissionResolver } from './permission-resolver.service';
import { RoleResolver } from './role-resolver.service';

export interface EffectivePermissionsResponse {
  userId: string;
  assignedRoles: string[];
  inheritedRoles: string[];
  resolvedPermissions: string[];
  permissionCategories: Record<string, string[]>;
  scopes: any[];
}

@Injectable()
export class AuthorizationService {
  private readonly logger = new Logger(AuthorizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolver,
    private readonly roleResolver: RoleResolver,
    private readonly scopeResolver: GeographicScopeResolver,
  ) {}

  /**
   * Evaluates if user possesses required permission(s).
   */
  async checkPermissions(userId: string, requiredPermissions: string[]): Promise<boolean> {
    return this.permissionResolver.checkUserHasPermissions(userId, requiredPermissions);
  }

  /**
   * Enforces permissions check, throwing ForbiddenException if unauthorized.
   */
  async enforcePermissions(userId: string, requiredPermissions: string[]): Promise<void> {
    const hasPerms = await this.checkPermissions(userId, requiredPermissions);
    if (!hasPerms) {
      throw new ForbiddenException(
        `Access denied: Missing required permission(s) [${requiredPermissions.join(', ')}]`,
      );
    }
  }

  /**
   * Evaluates if user possesses required role (direct or via hierarchy).
   */
  async checkRole(userId: string, roleName: string): Promise<boolean> {
    return this.roleResolver.hasRole(userId, roleName);
  }

  /**
   * Enforces role check, throwing ForbiddenException if unauthorized.
   */
  async enforceRole(userId: string, roleName: string): Promise<void> {
    const hasRole = await this.checkRole(userId, roleName);
    if (!hasRole) {
      throw new ForbiddenException(`Access denied: Required role '${roleName}' not present`);
    }
  }

  /**
   * Evaluates if action is authorized within target geographic scope context.
   */
  async checkGeographicScope(userId: string, context: ScopeContext): Promise<boolean> {
    return this.scopeResolver.isWithinScope(userId, context);
  }

  /**
   * Returns complete set of resolved user permission codes.
   */
  async getUserPermissions(userId: string): Promise<string[]> {
    const permsSet = await this.permissionResolver.resolveUserPermissions(userId);
    return Array.from(permsSet);
  }

  /**
   * Returns all direct and hierarchical user roles.
   */
  async getUserRoles(userId: string) {
    return this.roleResolver.resolveAllUserRoles(userId);
  }

  /**
   * Returns detailed user geographic scope assignments.
   */
  async getUserScopes(userId: string) {
    return this.scopeResolver.getUserScopes(userId);
  }

  /**
   * Returns full effective authorization profile for the current authenticated user.
   * Includes assigned roles, inherited roles, resolved permissions, categories, and scopes.
   */
  async getEffectivePermissions(userId: string): Promise<EffectivePermissionsResponse> {
    const allUserRoles = await this.roleResolver.resolveAllUserRoles(userId);
    const assignedRoles = allUserRoles.filter((r) => r.isDirect).map((r) => r.roleName);
    const inheritedRoles = allUserRoles.filter((r) => !r.isDirect).map((r) => r.roleName);

    const resolvedPermissionsSet = await this.permissionResolver.resolveUserPermissions(userId);
    const resolvedPermissions = Array.from(resolvedPermissionsSet);

    const scopes = await this.scopeResolver.getUserScopes(userId);

    // Group permissions by Category
    const permissionCategories: Record<string, string[]> = {};

    if (resolvedPermissionsSet.has('*')) {
      permissionCategories['SYSTEM'] = ['*'];
    } else if (resolvedPermissions.length > 0) {
      const permsFromDb = await this.prisma.permission.findMany({
        where: { code: { in: resolvedPermissions } },
      });

      for (const p of permsFromDb) {
        const cat = p.category || 'SYSTEM';
        if (!permissionCategories[cat]) {
          permissionCategories[cat] = [];
        }
        permissionCategories[cat].push(p.code);
      }
    }

    return {
      userId,
      assignedRoles,
      inheritedRoles,
      resolvedPermissions,
      permissionCategories,
      scopes,
    };
  }
}
