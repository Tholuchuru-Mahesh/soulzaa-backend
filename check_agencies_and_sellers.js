const { PrismaClient } = require('@prisma/client');

async function run() {
  const prisma = new PrismaClient();
  try {
    console.log('--- ALL USERS WITH ROLES & LOCATIONS ---');
    const users = await prisma.user.findMany({
      include: {
        locationCountry: true,
        locationState: true,
        locationRegion: true,
      }
    });

    for (const u of users) {
      console.log(`User: ${u.username || u.email} (${u.id})`);
      console.log(`  Roles: ${JSON.stringify(u.roles)}`);
      console.log(`  Location: ${u.locationState?.name || u.locationCountry?.name || 'Mumbai, India'}`);
      console.log(`  Coins Balance: ${u.goldCoins}`);

      const agencyRelCount = await prisma.agencyRelationship.count({
        where: { agencyId: u.id, status: 'ACTIVE' }
      });
      console.log(`  Active Agency Members: ${agencyRelCount}`);
    }

    const roleRequests = await prisma.roleRequest.findMany({
      where: { status: 'SUBMITTED' }
    });
    console.log(`\nPending Role Requests: ${roleRequests.length}`);
    for (const r of roleRequests) {
      console.log(`- Request ID: ${r.id} | Type: ${r.type} | SubjectUserID: ${r.subjectUserId}`);
    }
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
