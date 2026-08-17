const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

async function run() {
  const prisma = new PrismaClient();
  try {
    console.log('--- USERS & AUTH CREDENTIALS ---');
    const creds = await prisma.userCredential.findMany({
      include: {
        user: {
          select: { id: true, email: true, username: true, roles: true, status: true }
        }
      }
    });

    for (const c of creds) {
      console.log(`Email: ${c.user.email} | Username: ${c.user.username}`);
      console.log(`  Roles: ${JSON.stringify(c.user.roles)}`);
      console.log(`  Has Password Hash: ${!!c.passwordHash}`);
    }

    if (creds.length === 0) {
      console.log('No userCredential records found in DB.');
    }
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
