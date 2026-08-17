const { PrismaClient } = require('@prisma/client');

async function run() {
  const prisma = new PrismaClient();
  try {
    // Check what userRole has by looking at one record
    const sample = await prisma.userRole.findFirst();
    console.log('Sample userRole record:', JSON.stringify(sample, null, 2));

    // Also check roles table
    const roles = await prisma.role.findMany({ where: { name: 'OFFICIAL' } });
    console.log('\nOFFICIAL role entry:', JSON.stringify(roles, null, 2));

    if (roles.length > 0) {
      const officialRole = roles[0];
      const userRoles = await prisma.userRole.findMany({ where: { roleId: officialRole.id } });
      console.log('\nuserRole entries for OFFICIAL:', JSON.stringify(userRoles, null, 2));
    }
  } catch (err) {
    console.error(err.message);
  } finally {
    await prisma.$disconnect();
  }
}

run();
