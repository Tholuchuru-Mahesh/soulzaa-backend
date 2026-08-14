"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const rbac_permissions_constants_1 = require("../src/modules/authorization/constants/rbac-permissions.constants");
const rbac_seeder_service_1 = require("../src/modules/authorization/services/rbac-seeder.service");
const user_location_service_1 = require("../src/modules/organization/services/user-location.service");
const prisma = new client_1.PrismaClient();
async function main() {
    console.log('Seeding RBAC...');
    const roleMap = new Map();
    for (const roleName of Object.values(rbac_permissions_constants_1.SYSTEM_ROLES)) {
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
    const permMap = new Map();
    for (const p of rbac_permissions_constants_1.DEFAULT_PERMISSIONS) {
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
    for (const [roleName, permCodes] of Object.entries(rbac_permissions_constants_1.DEFAULT_ROLE_PERMISSIONS)) {
        const roleId = roleMap.get(roleName);
        if (!roleId)
            continue;
        const permissionIds = permCodes.includes('*')
            ? [...permMap.values()]
            : permCodes.map((code) => permMap.get(code)).filter((id) => Boolean(id));
        for (const permissionId of permissionIds) {
            await prisma.rolePermission.upsert({
                where: { roleId_permissionId: { roleId, permissionId } },
                create: { roleId, permissionId },
                update: {},
            });
        }
    }
    console.log('Role-Permission mappings seeded.');
    for (const edge of rbac_permissions_constants_1.DEFAULT_ROLE_HIERARCHY) {
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
    if (!process.argv.includes('--skip-backfill')) {
        const seeder = new rbac_seeder_service_1.RbacSeederService(prisma);
        const { scanned, created } = await seeder.backfillLegacyUserRoles();
        console.log(`Legacy role backfill: scanned ${scanned} users, created ${created} assignments.`);
        const locations = new user_location_service_1.UserLocationService(prisma);
        const loc = await locations.backfillFromProfileCountry();
        console.log(`User location backfill: scanned ${loc.scanned}, matched ${loc.matched}, skipped ${loc.skipped}.`);
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
//# sourceMappingURL=seed-rbac.js.map