const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({ select: { id: true, username: true, roles: true } });
  console.log('USERS:', users);
  const assignments = await prisma.officialTerritoryAssignment.findMany();
  console.log('ASSIGNMENTS:', assignments);
}

main().finally(() => prisma.$disconnect());
