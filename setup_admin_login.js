const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

async function run() {
  const prisma = new PrismaClient();
  try {
    const passwordHash = await bcrypt.hash('Admin@123456', 10);
    const emails = ['admin@soulzaa.com', 'admin@e2e.test', 'superadmin@e2e.test'];

    for (const email of emails) {
      const user = await prisma.user.findFirst({ where: { email } });
      if (user) {
        await prisma.userCredential.upsert({
          where: { userId: user.id },
          create: {
            userId: user.id,
            passwordHash,
            passwordUpdatedAt: new Date()
          },
          update: {
            passwordHash,
            passwordUpdatedAt: new Date()
          }
        });
      }
    }

    console.log('All admin accounts updated with password Admin@123456');
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
