import { PrismaClient, ScopeType } from '@prisma/client';
import { hash } from 'bcryptjs';

/**
 * E2E validation fixtures.
 *
 * Six operators, one per role we need to prove RBAC against, plus the geography
 * to scope them. Deliberately NOT part of the normal seed — these are throwaway
 * accounts with a known password and must never reach a real environment.
 */
const prisma = new PrismaClient();

const PASSWORD = 'E2ePass!2026';

interface Fixture {
  username: string;
  email: string;
  role: string | null;
  scopes?: Array<{ type: ScopeType; countryCode?: string; stateCode?: string; regionCode?: string }>;
  note: string;
}

const FIXTURES: Fixture[] = [
  { username: 'e2e_superadmin', email: 'superadmin@e2e.test', role: 'SUPER_ADMIN', note: 'wildcard' },
  { username: 'e2e_admin', email: 'admin@e2e.test', role: 'ADMIN', note: 'four dashboards' },
  {
    username: 'e2e_country_manager',
    email: 'cm@e2e.test',
    role: 'COUNTRY_MANAGER',
    scopes: [{ type: ScopeType.COUNTRY, countryCode: 'IN' }],
    note: 'scoped to India',
  },
  {
    username: 'e2e_official',
    email: 'official@e2e.test',
    role: 'OFFICIAL',
    scopes: [{ type: ScopeType.STATE, stateCode: 'KA' }],
    note: 'scoped to Karnataka',
  },
  {
    username: 'e2e_moderator',
    email: 'moderator@e2e.test',
    role: 'MODERATOR',
    scopes: [
      { type: ScopeType.REGION, regionCode: 'BLR' },
      { type: ScopeType.REGION, regionCode: 'VJA' },
    ],
    note: 'scoped to Bengaluru + Vijayawada',
  },
  { username: 'e2e_member', email: 'member@e2e.test', role: 'USER', note: 'no console access' },
];

async function main(): Promise<void> {
  const passwordHash = await hash(PASSWORD, 10);

  const country = await prisma.country.findUnique({ where: { code: 'IN' } });
  if (!country) throw new Error('Run seed-rbac.ts first — country IN is missing.');
  const state = await prisma.state.findFirst({ where: { countryId: country.id, code: 'KA' } });
  const region = await prisma.region.findFirst({ where: { stateId: state!.id, code: 'BLR' } });
  const stateAP = await prisma.state.findFirst({ where: { countryId: country.id, code: 'AP' } });
  const regionVJA = await prisma.region.findFirst({ where: { stateId: stateAP!.id, code: 'VJA' } });
  const stateTN = await prisma.state.findFirst({ where: { countryId: country.id, code: 'TN' } });
  const regionCHN = await prisma.region.findFirst({ where: { stateId: stateTN!.id, code: 'CHN' } });
  if (!regionVJA || !regionCHN) throw new Error('Run seed-rbac.ts first — Vijayawada/Chennai regions are missing.');

  const REGION_BY_CODE: Record<string, { id: string; stateId: string; countryId: string }> = {
    BLR: { id: region!.id, stateId: state!.id, countryId: country.id },
    VJA: { id: regionVJA.id, stateId: stateAP!.id, countryId: country.id },
    CHN: { id: regionCHN.id, stateId: stateTN!.id, countryId: country.id },
  };
  const STATE_BY_CODE: Record<string, { id: string; countryId: string }> = {
    KA: { id: state!.id, countryId: country.id },
    AP: { id: stateAP!.id, countryId: country.id },
    TN: { id: stateTN!.id, countryId: country.id },
  };

  // Population the scoped operators will actually see. Spread across the
  // hierarchy so an Official's view is provably narrower than a Manager's.
  const population = [
    { username: 'e2e_pop_blr', email: 'pop.blr@e2e.test', regionId: region!.id, stateId: state!.id, countryId: country.id },
    { username: 'e2e_pop_ka', email: 'pop.ka@e2e.test', regionId: null, stateId: state!.id, countryId: country.id },
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
    const primaryScope = fixture.scopes?.[0];
    // Resolved per the fixture's own primary scope code, not hardcoded to
    // BLR/KA — a fixture whose first scope entry is VJA/CHN or a non-KA
    // state must get ITS OWN region/state here, not Bengaluru's.
    const primaryStateId = primaryScope?.regionCode
      ? REGION_BY_CODE[primaryScope.regionCode].stateId
      : primaryScope?.stateCode
        ? STATE_BY_CODE[primaryScope.stateCode].id
        : null;
    const primaryRegionId = primaryScope?.regionCode ? REGION_BY_CODE[primaryScope.regionCode].id : null;
    const user = await prisma.user.upsert({
      where: { email: fixture.email },
      create: {
        username: fixture.username,
        email: fixture.email,
        country: 'IN',
        countryId: country.id,
        stateId: primaryStateId,
        regionId: primaryRegionId,
      },
      // Re-sync on every run (matches the `population` loop's pattern above)
      // so a fixture-definition change actually takes effect on already-
      // seeded environments, instead of freezing whatever was first created.
      update: {
        countryId: country.id,
        stateId: primaryStateId,
        regionId: primaryRegionId,
      },
    });

    // Credentials live on UserCredential, not User.
    await prisma.userCredential.upsert({
      where: { userId: user.id },
      create: { userId: user.id, passwordHash, passwordUpdatedAt: new Date() },
      update: { passwordHash },
    });

    if (!fixture.role) continue;

    const role = await prisma.role.findUnique({ where: { name: fixture.role } });
    if (!role) throw new Error(`Role ${fixture.role} not seeded.`);

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
          ...(scopeEntry.regionCode ? { regionId: REGION_BY_CODE[scopeEntry.regionCode].id } : {}),
        },
      });
      if (existing) continue;
      await prisma.roleScope.create({
        data: {
          userRoleId: userRole.id,
          scopeType: scopeEntry.type,
          countryId: scopeEntry.countryCode ? country.id : null,
          stateId: scopeEntry.stateCode ? state!.id : scopeEntry.regionCode ? REGION_BY_CODE[scopeEntry.regionCode].stateId : null,
          regionId: scopeEntry.regionCode ? REGION_BY_CODE[scopeEntry.regionCode].id : null,
        },
      });
    }

    console.log(`  ${fixture.email.padEnd(26)} ${(fixture.role ?? '—').padEnd(16)} ${fixture.note}`);
  }

  const roomOwners = [
    { username: 'e2e_room_owner_blr', email: 'roomowner.blr@e2e.test', regionId: region!.id, stateId: state!.id, countryId: country.id },
    { username: 'e2e_room_owner_vja', email: 'roomowner.vja@e2e.test', regionId: regionVJA.id, stateId: stateAP!.id, countryId: country.id },
    { username: 'e2e_room_owner_chn', email: 'roomowner.chn@e2e.test', regionId: regionCHN.id, stateId: stateTN!.id, countryId: country.id },
  ];
  for (const owner of roomOwners) {
    await prisma.user.upsert({
      where: { email: owner.email },
      create: {
        username: owner.username,
        email: owner.email,
        country: 'IN',
        countryId: owner.countryId,
        stateId: owner.stateId,
        regionId: owner.regionId,
      },
      update: {
        countryId: owner.countryId,
        stateId: owner.stateId,
        regionId: owner.regionId,
      },
    });
  }
  console.log(`Room owners seeded: ${roomOwners.length}`);

  const ROOMS = [
    { slug: 'blr', region: region!.id, ownerEmail: 'roomowner.blr@e2e.test' },
    { slug: 'vja', region: regionVJA.id, ownerEmail: 'roomowner.vja@e2e.test' },
    { slug: 'chn', region: regionCHN.id, ownerEmail: 'roomowner.chn@e2e.test' },
  ];
  for (const r of ROOMS) {
    const owner = await prisma.user.findUnique({ where: { email: r.ownerEmail } });
    if (!owner) throw new Error(`Room owner fixture ${r.ownerEmail} must run before room fixtures.`);
    await prisma.audioRoom.upsert({
      where: { agoraChannel: `e2e-room-${r.slug}` },
      create: {
        ownerId: owner.id,
        name: `E2E Room ${r.slug.toUpperCase()}`,
        maxParticipants: 10,
        agoraChannel: `e2e-room-${r.slug}`,
        status: 'LIVE',
        region: r.region,
      },
      update: { region: r.region, status: 'LIVE' },
    });
  }
  console.log(`Rooms seeded: ${ROOMS.length} (one per region)`);

  console.log(`\nAll fixtures share the password: ${PASSWORD}`);
}

main()
  .catch((e) => {
    console.error('Fixture seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
