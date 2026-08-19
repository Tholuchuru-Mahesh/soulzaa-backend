const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

async function run() {
  const prisma = new PrismaClient();
  try {
    const email = 'superadmin@soulzaa.com';
    const password = 'Super@*12345';
    const passwordHash = await bcrypt.hash(password, 10);

    // Find the user or create them if they don't exist
    let user = await prisma.user.findFirst({ where: { email } });
    
    if (!user) {
      console.log(`User ${email} not found, creating a new superadmin user...`);
      user = await prisma.user.create({
        data: {
          email,
          username: 'production_superadmin',
          country: 'IN',
        }
      });
      
      // Assign SUPER_ADMIN role
      const role = await prisma.role.findUnique({ where: { name: 'SUPER_ADMIN' } });
      if (role) {
        await prisma.userRole.create({
          data: {
            userId: user.id,
            roleId: role.id
          }
        });
      } else {
        console.warn('SUPER_ADMIN role not found in the database. Ensure roles are seeded.');
      }
    }

    // Update or create the credential
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

    console.log(`Successfully set credentials for ${email}`);
  } catch (err) {
    console.error('Error updating production admin:', err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
