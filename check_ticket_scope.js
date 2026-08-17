const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const supportPerms = await prisma.permission.findMany({
    where: {
      OR: [
        { code: { contains: 'support' } },
        { module: { contains: 'support' } },
        { code: { contains: 'ticket' } },
      ]
    }
  });
  console.log('Support Permissions in DB:', supportPerms);
}

main().catch(console.error).finally(() => prisma.$disconnect());
