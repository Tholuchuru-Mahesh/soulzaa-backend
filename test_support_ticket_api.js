const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testQuery() {
  const anna = await prisma.user.findFirst({ where: { email: 'pothireddy.172@gmail.com' } });
  console.log('Anna ID:', anna.id);

  const userRoles = await prisma.userRole.findMany({ where: { userId: anna.id } });
  console.log('Anna userRoles:', userRoles);

  const roleRoleIds = userRoles.map(ur => ur.id);
  const roleScopes = await prisma.roleScope.findMany({ where: { userRoleId: { in: roleRoleIds } } });
  console.log('Anna roleScopes:', roleScopes);
}

testQuery().catch(console.error).finally(() => prisma.$disconnect());
