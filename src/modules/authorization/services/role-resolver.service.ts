import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuthorizationCacheService } from './authorization-cache.service';

export interface UserRoleInfo {
  roleId: string;
  roleName: string;
  isDirect: boolean;
}

@Injectable()
export class RoleResolver {
  private readonly logger = new Logger(RoleResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: AuthorizationCacheService,
  ) {}

  /**
   * Resolves direct roles assigned to a user via UserRole entity.
   */
  async getDirectUserRoles(userId: string): Promise<Array<{ id: string; name: string }>> {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId, suspendedAt: null },
      include: { role: true },
    });
    return userRoles.map((ur) => ({ id: ur.role.id, name: ur.role.name }));
  }

  /**
   * Resolves the entire hierarchical set of roles for a user with Redis caching.
   */
  async resolveAllUserRoles(userId: string): Promise<UserRoleInfo[]> {
    const cached = await this.cacheService.getCachedRoles<UserRoleInfo>(userId);
    if (cached !== null) {
      return cached;
    }

    const directRoles = await this.getDirectUserRoles(userId);
    if (directRoles.length === 0) {
      await this.cacheService.setCachedRoles(userId, []);
      return [];
    }

    const roleMap = new Map<string, UserRoleInfo>();

    // Load all role hierarchy edges from DB
    const hierarchyEdges = await this.prisma.roleHierarchy.findMany({
      include: {
        parentRole: true,
        childRole: true,
      },
    });

    // Build parent-to-children adj list
    const parentToChildren = new Map<string, Array<{ id: string; name: string }>>();
    for (const edge of hierarchyEdges) {
      const list = parentToChildren.get(edge.parentRoleId) ?? [];
      list.push({ id: edge.childRole.id, name: edge.childRole.name });
      parentToChildren.set(edge.parentRoleId, list);
    }

    // Traverse starting from direct roles
    const queue: Array<{ id: string; name: string; isDirect: boolean }> = directRoles.map((r) => ({
      ...r,
      isDirect: true,
    }));

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (!roleMap.has(current.id)) {
        roleMap.set(current.id, {
          roleId: current.id,
          roleName: current.name,
          isDirect: current.isDirect,
        });

        // Add child roles inherited from current parent role
        const children = parentToChildren.get(current.id) ?? [];
        for (const child of children) {
          if (!roleMap.has(child.id)) {
            queue.push({ ...child, isDirect: false });
          }
        }
      }
    }

    const result = Array.from(roleMap.values());
    await this.cacheService.setCachedRoles(userId, result);
    return result;
  }

  /**
   * Effective role names for a user. Implements the IRoleSource port that
   * common-layer guards depend on (they cannot import this module directly).
   */
  async getRoleNames(userId: string): Promise<string[]> {
    const roles = await this.resolveAllUserRoles(userId);
    return roles.map((r) => r.roleName);
  }

  /**
   * Checks if a user possesses a specific role (directly or hierarchically).
   */
  async hasRole(userId: string, targetRoleName: string): Promise<boolean> {
    const roles = await this.resolveAllUserRoles(userId);
    return roles.some((r) => r.roleName === targetRoleName);
  }

  /**
   * Reverse lookup over direct assignments. Uncached on purpose: the only
   * caller is a reconciliation job, and a stale answer there would silently
   * leave accounts unreconciled.
   */
  async getUserIdsWithAnyRole(roleNames: string[]): Promise<string[]> {
    if (roleNames.length === 0) return [];
    const rows = await this.prisma.userRole.findMany({
      where: { role: { name: { in: roleNames } } },
      select: { userId: true },
    });
    return [...new Set(rows.map((r) => r.userId))];
  }
}
