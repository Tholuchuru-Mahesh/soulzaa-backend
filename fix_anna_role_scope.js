const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const anna = await prisma.user.findFirst({ where: { email: 'pothireddy.172@gmail.com' } });
  if (!anna) {
    console.error('Anna user not found');
    return;
  }

  const officialUserRole = await prisma.userRole.findFirst({
    where: {
      userId: anna.id,
      role: { name: 'OFFICIAL' }
    }
  });

  if (!officialUserRole) {
    console.error('OFFICIAL UserRole not found for Anna');
    return;
  }

  console.log('Anna OFFICIAL UserRole ID:', officialUserRole.id);

  // Link RoleScope
  let scope = await prisma.roleScope.findFirst({
    where: { userRoleId: officialUserRole.id }
  });

  if (!scope) {
    scope = await prisma.roleScope.create({
      data: {
        userRoleId: officialUserRole.id,
        scopeType: 'REGION',
        countryId: anna.countryId,
        stateId: anna.stateId,
        regionId: anna.regionId,
      }
    });
    console.log('Created RoleScope for Anna:', scope);
  } else {
    console.log('RoleScope already exists for Anna:', scope);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
