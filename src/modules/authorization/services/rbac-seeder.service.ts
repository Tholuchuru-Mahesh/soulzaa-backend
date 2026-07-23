import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ScopeType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  DEFAULT_PERMISSIONS,
  DEFAULT_ROLE_HIERARCHY,
  DEFAULT_ROLE_PERMISSIONS,
  SYSTEM_ROLES,
} from '../constants/rbac-permissions.constants';

@Injectable()
export class RbacSeederService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RbacSeederService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.seedAll();
    } catch (err) {
      this.logger.warn(`RBAC database seed skipped: ${(err as Error).message}`);
    }
  }

  /**
   * Idempotently seeds all default system roles, permissions, role-permission matrix, role hierarchy edges, and geographic data.
   */
  async seedAll(): Promise<void> {
    this.logger.log('Initializing RBAC database seed...');

    // 1. Seed Roles
    const roleMap = new Map<string, string>(); // roleName -> roleId
    for (const roleName of Object.values(SYSTEM_ROLES)) {
      const role = await this.prisma.role.upsert({
        where: { name: roleName },
        create: {
          name: roleName,
          displayName: roleName.replace(/_/g, ' '),
          description: `System defined ${roleName} role`,
          isSystem: true,
        },
        update: {
          isSystem: true,
        },
      });
      roleMap.set(roleName, role.id);
    }
    this.logger.log(`Seeded ${roleMap.size} system roles`);

    // 2. Seed Permissions with Categories
    const permMap = new Map<string, string>(); // permCode -> permId
    for (const p of DEFAULT_PERMISSIONS) {
      const perm = await this.prisma.permission.upsert({
        where: { code: p.code },
        create: {
          code: p.code,
          module: p.module,
          action: p.action,
          category: p.category || 'SYSTEM',
          displayName: p.displayName,
          description: p.description,
        },
        update: {
          category: p.category || 'SYSTEM',
          displayName: p.displayName,
          description: p.description,
        },
      });
      permMap.set(p.code, perm.id);
    }
    this.logger.log(`Seeded ${permMap.size} system permissions with categories`);

    // 3. Seed Role-Permission Mappings
    let mappingsCount = 0;
    for (const [roleName, permCodes] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      const roleId = roleMap.get(roleName);
      if (!roleId) continue;

      if (permCodes.includes('*')) {
        for (const permId of permMap.values()) {
          await this.prisma.rolePermission.upsert({
            where: {
              roleId_permissionId: { roleId, permissionId: permId },
            },
            create: { roleId, permissionId: permId },
            update: {},
          });
          mappingsCount++;
        }
      } else {
        for (const code of permCodes) {
          const permId = permMap.get(code);
          if (!permId) continue;
          await this.prisma.rolePermission.upsert({
            where: {
              roleId_permissionId: { roleId, permissionId: permId },
            },
            create: { roleId, permissionId: permId },
            update: {},
          });
          mappingsCount++;
        }
      }
    }
    this.logger.log(`Seeded ${mappingsCount} role-permission mappings`);

    // 4. Seed Data-Driven Role Hierarchy
    let hierarchyCount = 0;
    for (const edge of DEFAULT_ROLE_HIERARCHY) {
      const parentRoleId = roleMap.get(edge.parent);
      const childRoleId = roleMap.get(edge.child);
      if (parentRoleId && childRoleId) {
        await this.prisma.roleHierarchy.upsert({
          where: {
            parentRoleId_childRoleId: { parentRoleId, childRoleId },
          },
          create: { parentRoleId, childRoleId },
          update: {},
        });
        hierarchyCount++;
      }
    }
    this.logger.log(`Seeded ${hierarchyCount} role hierarchy edges`);

    // 5. Seed Default Geographic Infrastructure Reference Data
    const country = await this.prisma.country.upsert({
      where: { code: 'IN' },
      create: { code: 'IN', name: 'India' },
      update: { name: 'India' },
    });

    const state = await this.prisma.state.upsert({
      where: { countryId_code: { countryId: country.id, code: 'KA' } },
      create: { countryId: country.id, code: 'KA', name: 'Karnataka' },
      update: { name: 'Karnataka' },
    });

    await this.prisma.region.upsert({
      where: { stateId_code: { stateId: state.id, code: 'BLR' } },
      create: { stateId: state.id, code: 'BLR', name: 'Bengaluru Region' },
      update: { name: 'Bengaluru Region' },
    });

    this.logger.log('RBAC Database Seed Completed successfully');
  }
}
