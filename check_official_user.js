const { PrismaClient } = require('@prisma/client');

async function run() {
  const prisma = new PrismaClient();
  try {
    // Check WorkforceAssignment table for OFFICIAL role
    const assignments = await prisma.workforceAssignment.findMany({
      where: { roleName: 'OFFICIAL' },
      include: {
        user: { select: { username: true, email: true } }
      }
    });

    if (assignments.length > 0) {
      console.log('Officials (from WorkforceAssignment):');
      for (const a of assignments) {
        console.log(' -', a.user.username, '|', a.user.email);
      }
    } else {
      console.log('No OFFICIAL found in WorkforceAssignment table.');
    }
  } catch (e1) {
    console.log('WorkforceAssignment table error:', e1.message);

    // Fallback: check roles array on user
    const prisma2 = new PrismaClient();
    try {
      const users = await prisma2.user.findMany({
        select: { username: true, email: true, roles: true }
      });
      const officials = users.filter(u => u.roles.includes('OFFICIAL'));
      if (officials.length > 0) {
        console.log('Officials (from User.roles):');
        for (const u of officials) {
          console.log(' -', u.username, '|', u.email);
        }
      } else {
        console.log('No OFFICIAL role found on any user.');
      }
    } finally {
      await prisma2.$disconnect();
    }
  } finally {
    await prisma.$disconnect();
  }
}

run();
