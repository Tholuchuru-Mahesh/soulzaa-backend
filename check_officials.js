const { PrismaClient } = require('@prisma/client');

async function run() {
  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({
      select: { id: true, username: true, email: true, roles: true, status: true }
    });

    const operational = users.filter(u =>
      u.roles.some(r => ['OFFICIAL', 'COUNTRY_MANAGER', 'MODERATOR', 'SUPER_ADMIN', 'ADMIN'].includes(r))
    );

    if (operational.length === 0) {
      console.log('No users with OFFICIAL / COUNTRY_MANAGER / MODERATOR / SUPER_ADMIN / ADMIN roles found.');
    } else {
      console.log('Users with operational roles:');
      for (const u of operational) {
        console.log(`  Username : ${u.username}`);
        console.log(`  Email    : ${u.email}`);
        console.log(`  Roles    : ${JSON.stringify(u.roles)}`);
        console.log(`  Status   : ${u.status}`);
        console.log('');
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
