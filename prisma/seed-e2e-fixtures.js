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
        scopes: [{ type: client_1.ScopeType.COUNTRY, countryCode: 'IN' }],
        note: 'scoped to India',
    },
    {
        username: 'e2e_official',
        email: 'official@e2e.test',
        role: 'OFFICIAL',
        scopes: [{ type: client_1.ScopeType.STATE, stateCode: 'KA' }],
        note: 'scoped to Karnataka',
    },
    {
        username: 'e2e_moderator',
        email: 'moderator@e2e.test',
        role: 'MODERATOR',
        scopes: [
            { type: client_1.ScopeType.STATE, stateCode: 'KA' },
            { type: client_1.ScopeType.STATE, stateCode: 'AP' },
        ],
        note: 'scoped to Karnataka + Andhra Pradesh',
    },
    { username: 'e2e_member', email: 'member@e2e.test', role: 'USER', note: 'no console access' },
];
async function main() {
    const passwordHash = await (0, bcryptjs_1.hash)(PASSWORD, 10);
    const country = await prisma.country.findUnique({ where: { code: 'IN' } });
    if (!country)
        throw new Error('Country IN is missing.');
    const state = await prisma.state.findFirst({ where: { countryId: country.id, code: 'KA' } });
    const stateAP = await prisma.state.findFirst({ where: { countryId: country.id, code: 'AP' } });
    const stateTN = await prisma.state.findFirst({ where: { countryId: country.id, code: 'TN' } });
    const region = await prisma.region.findFirst({ where: { stateId: state ? state.id : '', code: 'BLR' } });
    const STATE_BY_CODE = {
        KA: state ? { id: state.id, countryId: country.id } : { id: '', countryId: country.id },
        AP: stateAP ? { id: stateAP.id, countryId: country.id } : { id: '', countryId: country.id },
        TN: stateTN ? { id: stateTN.id, countryId: country.id } : { id: '', countryId: country.id },
    };
    let displayIdCounter = 90001000;
    const population = [
        { username: 'e2e_pop_blr', email: 'pop.blr@e2e.test', regionId: region ? region.id : null, stateId: state ? state.id : null, countryId: country.id },
        { username: 'e2e_pop_ka', email: 'pop.ka@e2e.test', regionId: null, stateId: state ? state.id : null, countryId: country.id },
        { username: 'e2e_pop_in', email: 'pop.in@e2e.test', regionId: null, stateId: null, countryId: country.id },
        { username: 'e2e_pop_nowhere', email: 'pop.none@e2e.test', regionId: null, stateId: null, countryId: null },
    ];
    for (const person of population) {
        await prisma.user.upsert({
            where: { email: person.email },
            create: {
                displayId: displayIdCounter++,
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
        const primaryScope = fixture.scopes?.[0];
        const primaryStateId = primaryScope?.stateCode && STATE_BY_CODE[primaryScope.stateCode] ? STATE_BY_CODE[primaryScope.stateCode].id : null;
        const user = await prisma.user.upsert({
            where: { email: fixture.email },
            create: {
                displayId: displayIdCounter++,
                username: fixture.username,
                email: fixture.email,
                country: 'IN',
                countryId: country.id,
                stateId: primaryStateId,
            },
            update: {
                countryId: country.id,
                stateId: primaryStateId,
            },
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
        for (const scopeEntry of fixture.scopes ?? []) {
            const existing = await prisma.roleScope.findFirst({
                where: {
                    userRoleId: userRole.id,
                    scopeType: scopeEntry.type,
                    ...(scopeEntry.stateCode && STATE_BY_CODE[scopeEntry.stateCode] ? { stateId: STATE_BY_CODE[scopeEntry.stateCode].id } : {}),
                },
            });
            if (existing)
                continue;
            await prisma.roleScope.create({
                data: {
                    userRoleId: userRole.id,
                    scopeType: scopeEntry.type,
                    countryId: scopeEntry.countryCode ? country.id : null,
                    stateId: scopeEntry.stateCode && STATE_BY_CODE[scopeEntry.stateCode] ? STATE_BY_CODE[scopeEntry.stateCode].id : null,
                },
            });
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