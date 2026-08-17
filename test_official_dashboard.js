const { PrismaClient } = require('@prisma/client');

async function run() {
  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        email: true,
        roles: true,
        countryId: true,
        stateId: true,
        regionId: true,
      }
    });

    console.log(`Total users in DB: ${users.length}`);
    for (const u of users) {
      console.log(`User: ${u.username || u.email} (${u.id}) | Roles: ${JSON.stringify(u.roles)} | CountryID: ${u.countryId} | StateID: ${u.stateId} | RegionID: ${u.regionId}`);
    }
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
