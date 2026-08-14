"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const bcryptjs_1 = require("bcryptjs");
const prisma = new client_1.PrismaClient();
const PASSWORD = 'E2ePass!2026';
const FIXTURES = [
    { username: 'e2e_superadmin', email: 'superadmin@e2e.test', role: 'SUPER_ADMIN', note: 'wildcard' },
    { username: 'e2e_admin', email: 'admin@e2e.test', role: 'ADMIN', note: 'four dashboards' },
    {
        username: 'e2e_country_manager',
        email: 'cm@e2e.test',
        role: 'COUNTRY_MANAGER',
        scope: { type: client_1.ScopeType.COUNTRY, countryCode: 'IN' },
        note: 'scoped to India',
    },
    {
        username: 'e2e_official',
        email: 'official@e2e.test',
        role: 'OFFICIAL',
        scope: { type: client_1.ScopeType.STATE, stateCode: 'KA' },
        note: 'scoped to Karnataka',
    },
    {
        username: 'e2e_moderator',
        email: 'moderator@e2e.test',
        role: 'MODERATOR',
        scope: { type: client_1.ScopeType.REGION, regionCode: 'BLR' },
        note: 'scoped to Bengaluru',
    },
    { username: 'e2e_member', email: 'member@e2e.test', role: 'USER', note: 'no console access' },
];
async function main() {
    const passwordHash = await (0, bcryptjs_1.hash)(PASSWORD, 10);
    const country = await prisma.country.findUnique({ where: { code: 'IN' } });
    if (!country)
        throw new Error('Run seed-rbac.ts first — country IN is missing.');
    const state = await prisma.state.findFirst({ where: { countryId: country.id, code: 'KA' } });
    const region = await prisma.region.findFirst({ where: { stateId: state.id, code: 'BLR' } });
    const population = [
        { username: 'e2e_pop_blr', email: 'pop.blr@e2e.test', regionId: region.id, stateId: state.id, countryId: country.id },
        { username: 'e2e_pop_ka', email: 'pop.ka@e2e.test', regionId: null, stateId: state.id, countryId: country.id },
        { username: 'e2e_pop_in', email: 'pop.in@e2e.test', regionId: null, stateId: null, countryId: country.id },
        { username: 'e2e_pop_nowhere', email: 'pop.none@e2e.test', regionId: null, stateId: null, countryId: null },
    ];
    for (const person of population) {
        await prisma.user.upsert({
            where: { email: person.email },
            create: {
                username: person.username,
                email: person.email,
                country: 'IN',
                countryId: person.countryId,
                stateId: person.stateId,
                regionId: person.regionId,
            },
            update: {
                countryId: person.countryId,
                stateId: person.stateId,
                regionId: person.regionId,
            },
        });
    }
    console.log(`Population seeded: ${population.length}`);
    for (const fixture of FIXTURES) {
        const user = await prisma.user.upsert({
            where: { email: fixture.email },
            create: {
                username: fixture.username,
                email: fixture.email,
                country: 'IN',
                countryId: country.id,
                stateId: fixture.scope?.stateCode ? state.id : null,
                regionId: fixture.scope?.regionCode ? region.id : null,
            },
            update: {},
        });
        await prisma.userCredential.upsert({
            where: { userId: user.id },
            create: { userId: user.id, passwordHash, passwordUpdatedAt: new Date() },
            update: { passwordHash },
        });
        if (!fixture.role)
            continue;
        const role = await prisma.role.findUnique({ where: { name: fixture.role } });
        if (!role)
            throw new Error(`Role ${fixture.role} not seeded.`);
        const userRole = await prisma.userRole.upsert({
            where: { userId_roleId: { userId: user.id, roleId: role.id } },
            create: { userId: user.id, roleId: role.id },
            update: {},
        });
        if (fixture.scope) {
            const existing = await prisma.roleScope.findFirst({ where: { userRoleId: userRole.id } });
            if (!existing) {
                await prisma.roleScope.create({
                    data: {
                        userRoleId: userRole.id,
                        scopeType: fixture.scope.type,
                        countryId: fixture.scope.countryCode ? country.id : null,
                        stateId: fixture.scope.stateCode ? state.id : null,
                        regionId: fixture.scope.regionCode ? region.id : null,
                    },
                });
            }
        }
        console.log(`  ${fixture.email.padEnd(26)} ${(fixture.role ?? '—').padEnd(16)} ${fixture.note}`);
    }
    console.log(`\nAll fixtures share the password: ${PASSWORD}`);
}
main()
    .catch((e) => {
    console.error('Fixture seed failed:', e);
    process.exit(1);
})
    .finally(() => prisma.$disconnect());
//# sourceMappingURL=seed-e2e-fixtures.js.map