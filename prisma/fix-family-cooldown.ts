import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Checking family configs and histories...');
  const configs = await prisma.familyConfiguration.findMany();
  console.log('Family configurations:', configs);

  await prisma.familyConfiguration.upsert({
    where: { key: 'family.join_cooldown' },
    update: { value: 0 },
    create: { key: 'family.join_cooldown', value: 0 },
  });
  console.log('Set family.join_cooldown to 0 for instant development testing.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
