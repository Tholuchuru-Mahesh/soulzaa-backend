const { PrismaClient } = require('@prisma/client');

async function run() {
  const prisma = new PrismaClient();
  try {
    // Find all users who have AGENCY or COIN_SELLER roles
    const usersToFix = await prisma.user.findMany({
      where: {
        roles: { hasSome: ['AGENCY', 'COIN_SELLER'] }
      },
      select: { id: true, username: true, roles: true }
    });

    console.log(`Found ${usersToFix.length} user(s) with AGENCY or COIN_SELLER roles:`);
    for (const u of usersToFix) {
      console.log(`  - ${u.username} (${u.id}): ${JSON.stringify(u.roles)}`);
    }

    if (usersToFix.length === 0) {
      console.log('Nothing to do.');
      return;
    }

    // Strip AGENCY and COIN_SELLER from each user, keep everything else (e.g. USER)
    for (const u of usersToFix) {
      const cleanedRoles = u.roles.filter(
        (r) => r !== 'AGENCY' && r !== 'COIN_SELLER'
      );
      await prisma.user.update({
        where: { id: u.id },
        data: { roles: cleanedRoles }
      });
      console.log(`  ✓ Updated ${u.username}: ${JSON.stringify(u.roles)} → ${JSON.stringify(cleanedRoles)}`);
    }

    console.log('\nDone. All AGENCY and COIN_SELLER roles removed.');
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
