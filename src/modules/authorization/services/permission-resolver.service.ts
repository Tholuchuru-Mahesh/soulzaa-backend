import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { SYSTEM_ROLES } from '../constants/rbac-permissions.constants';
import { AuthorizationCacheService } from './authorization-cache.service';
import { RoleResolver } from './role-resolver.service';

@Injectable()
export class PermissionResolver {
  private readonly logger = new Logger(PermissionResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly roleResolver: RoleResolver,
    private readonly cacheService: AuthorizationCacheService,
  ) {}

  /**
   * Resolves the full set of permission codes for a given user.
   * Leverages Redis cache-aside layer with automatic database fallback.
   */
  async resolveUserPermissions(userId: string): Promise<Set<string>> {
    // 1. Try fetching from Redis cache
    const cached = await this.cacheService.getCachedPermissions(userId);
    if (cached !== null) {
      return new Set(cached);
    }

    // 2. Cache miss — resolve dynamically from DB
    const roles = await this.roleResolver.resolveAllUserRoles(userId);
    const permissionCodes = new Set<string>();

    if (roles.length === 0) {
      await this.cacheService.setCachedPermissions(userId, []);
      return permissionCodes;
    }

    // SUPER_ADMIN wildcard bypass
    if (roles.some((r) => r.roleName === SYSTEM_ROLES.SUPER_ADMIN)) {
      permissionCodes.add('*');
      await this.cacheService.setCachedPermissions(userId, ['*']);
      return permissionCodes;
    }

    const roleIds = roles.map((r) => r.roleId);

    // Fetch all permission mappings for the active role set
    const rolePermissions = await this.prisma.rolePermission.findMany({
      where: { roleId: { in: roleIds } },
      include: { permission: true },
    });

    for (const rp of rolePermissions) {
      permissionCodes.add(rp.permission.code);
    }

    const permsArray = Array.from(permissionCodes);
    await this.cacheService.setCachedPermissions(userId, permsArray);

    return permissionCodes;
  }

  /**
   * Evaluates if a set of user permission codes satisfies required permission(s).
   * Supports:
   * 1. Wildcard '*' (Super Admin)
   * 2. Module wildcard (e.g. 'wallet.*' matching 'wallet.adjust')
   * 3. Exact code match (e.g. 'wallet.adjust')
   */
  hasPermission(userPermissions: Set<string>, requiredPermission: string): boolean {
    if (userPermissions.has('*')) {
      return true;
    }

    if (userPermissions.has(requiredPermission)) {
      return true;
    }

    const parts = requiredPermission.split('.');
    if (parts.length > 1) {
      const moduleWildcard = `${parts[0]}.*`;
      if (userPermissions.has(moduleWildcard)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Checks if a user has all of the specified required permissions.
   */
  async checkUserHasPermissions(userId: string, requiredPermissions: string[]): Promise<boolean> {
    if (requiredPermissions.length === 0) {
      return true;
    }

    const userPermissions = await this.resolveUserPermissions(userId);
    return requiredPermissions.every((perm) => this.hasPermission(userPermissions, perm));
  }
}
