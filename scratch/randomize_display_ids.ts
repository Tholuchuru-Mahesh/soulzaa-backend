import { PrismaClient } from '@prisma/client';
import { randomInt } from 'node:crypto';

async function main() {
  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({
      select: { id: true, displayId: true },
      orderBy: { createdAt: 'asc' },
    });

    console.log(`Found ${users.length} users.`);
    const usedIds = new Set<number>();

    for (const user of users) {
      let newId = randomInt(10000000, 100000000);
      while (usedIds.has(newId)) {
        newId = randomInt(10000000, 100000000);
      }
      usedIds.add(newId);

      await prisma.user.update({
        where: { id: user.id },
        data: { displayId: newId },
      });
      console.log(`User ${user.id}: displayId ${user.displayId} -> ${newId}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
