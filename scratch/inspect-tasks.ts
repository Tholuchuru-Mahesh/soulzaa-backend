import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('--- EVENT DEFINITIONS ---');
  const events = await prisma.eventDefinition.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  console.dir(events, { depth: null });

  console.log('--- TASK DEFINITIONS ---');
  const tasks = await prisma.taskDefinition.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  console.dir(tasks, { depth: null });
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
