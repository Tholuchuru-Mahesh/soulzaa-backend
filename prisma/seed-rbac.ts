import { PrismaClient } from '@prisma/client';

import type { PrismaService } from '../src/infra/prisma/prisma.service';
import {
  DEFAULT_PERMISSIONS,
  DEFAULT_ROLE_HIERARCHY,
  DEFAULT_ROLE_PERMISSIONS,
  SYSTEM_ROLES,
} from '../src/modules/authorization/constants/rbac-permissions.constants';
import { RbacSeederService } from '../src/modules/authorization/services/rbac-seeder.service';
import { UserLocationService } from '../src/modules/organization/services/user-location.service';

/**
 * Standalone RBAC seed (`npx ts-node prisma/seed-rbac.ts`).
 *
 * Roles, permissions, the role→permission matrix and the hierarchy all come
 * from the shared constants that RbacSeederService uses at bootstrap — this
 * script must never declare its own copy. It previously did, and the two
 * drifted: ADMIN got 49 permissions here versus 23 there, so whichever ran last
 * silently decided what an Admin could actually do.
 *
 * Beyond the shared seed this also creates the geographic reference rows used
 * by local development.
 */
const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log('Seeding RBAC...');

  const roleMap = new Map<string, string>();
  for (const roleName of Object.values(SYSTEM_ROLES)) {
    const role = await prisma.role.upsert({
      where: { name: roleName },
      create: {
        name: roleName,
        displayName: roleName.replace(/_/g, ' '),
        description: `System defined ${roleName} role`,
        isSystem: true,
      },
      update: { isSystem: true },
    });
    roleMap.set(roleName, role.id);
  }
  console.log(`Roles seeded: ${roleMap.size}`);

  const permMap = new Map<string, string>();
  for (const p of DEFAULT_PERMISSIONS) {
    const perm = await prisma.permission.upsert({
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
  console.log(`Permissions seeded: ${permMap.size}`);

  for (const [roleName, permCodes] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const roleId = roleMap.get(roleName);
    if (!roleId) continue;

    const permissionIds = permCodes.includes('*')
      ? [...permMap.values()]
      : permCodes.map((code) => permMap.get(code)).filter((id): id is string => Boolean(id));

    for (const permissionId of permissionIds) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId, permissionId } },
        create: { roleId, permissionId },
        update: {},
      });
    }
  }
  console.log('Role-Permission mappings seeded.');

  for (const edge of DEFAULT_ROLE_HIERARCHY) {
    const parentRoleId = roleMap.get(edge.parent);
    const childRoleId = roleMap.get(edge.child);
    if (parentRoleId && childRoleId) {
      await prisma.roleHierarchy.upsert({
        where: { parentRoleId_childRoleId: { parentRoleId, childRoleId } },
        create: { parentRoleId, childRoleId },
        update: {},
      });
    }
  }
  console.log('Role hierarchy seeded.');

  const country = await prisma.country.upsert({
    where: { code: 'IN' },
    create: { code: 'IN', name: 'India' },
    update: { name: 'India' },
  });

  const state = await prisma.state.upsert({
    where: { countryId_code: { countryId: country.id, code: 'KA' } },
    create: { countryId: country.id, code: 'KA', name: 'Karnataka' },
    update: { name: 'Karnataka' },
  });

  await prisma.region.upsert({
    where: { stateId_code: { stateId: state.id, code: 'BLR' } },
    create: { stateId: state.id, code: 'BLR', name: 'Bengaluru Region' },
    update: { name: 'Bengaluru Region' },
  });

  console.log('Geographic reference data seeded successfully.');

  // Reconcile the legacy `User.roles` column into UserRole rows. Additive only —
  // it never deletes an assignment. Pass --skip-backfill to seed without it.
  if (!process.argv.includes('--skip-backfill')) {
    const seeder = new RbacSeederService(prisma as unknown as PrismaService);
    const { scanned, created } = await seeder.backfillLegacyUserRoles();
    console.log(`Legacy role backfill: scanned ${scanned} users, created ${created} assignments.`);

    // Seed countryId from the free-text profile country. Additive and idempotent
    // — only touches users whose countryId is still null.
    const locations = new UserLocationService(prisma as unknown as PrismaService);
    const loc = await locations.backfillFromProfileCountry();
    console.log(
      `User location backfill: scanned ${loc.scanned}, matched ${loc.matched}, skipped ${loc.skipped}.`,
    );
  }
}

main()
  .catch((e) => {
    console.error('Error during RBAC seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
