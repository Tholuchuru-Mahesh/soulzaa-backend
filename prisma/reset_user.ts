import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const searchTerm = process.argv[2] || 'c2solzaa';
  console.log(`Searching for test user matching: "${searchTerm}"...`);

  // Find user by username, email, or mobile (case-insensitive substring match)
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { username: { contains: searchTerm, mode: 'insensitive' } },
        { email: { contains: searchTerm, mode: 'insensitive' } },
        { mobile: { contains: searchTerm, mode: 'insensitive' } },
        { fullName: { contains: searchTerm, mode: 'insensitive' } },
      ],
    },
    include: {
      locationCountry: true,
      locationState: true,
      locationRegion: true,
    },
  });

  if (users.length === 0) {
    console.log(`\n⚠️  No user found matching "${searchTerm}".`);
    console.log('You can register/login with this account directly as a fresh user!');
    return;
  }

  for (const user of users) {
    console.log(`\nFound User:`);
    console.log(`- ID: ${user.id}`);
    console.log(`- Username: ${user.username}`);
    console.log(`- Full Name: ${user.fullName}`);
    console.log(`- Email: ${user.email}`);
    console.log(`- Mobile: ${user.mobile}`);
    console.log(`- Country: ${user.country} (ID: ${user.countryId})`);
    console.log(`- State ID: ${user.stateId}`);
    console.log(`- Region ID: ${user.regionId}`);

    console.log(`\n🧹 Cleaning up all related records for user ${user.username} (${user.id})...`);

    await prisma.$transaction(async (tx) => {
      // Delete user credentials and auth providers
      await tx.userAuthProvider.deleteMany({ where: { userId: user.id } });
      await tx.userCredential.deleteMany({ where: { userId: user.id } });
      await tx.passwordResetToken.deleteMany({ where: { userId: user.id } });

      // Delete profiles & stats
      await tx.userProfile.deleteMany({ where: { userId: user.id } });
      await tx.userStatistics.deleteMany({ where: { userId: user.id } });
      await tx.userVerification.deleteMany({ where: { userId: user.id } });

      // Delete user directly
      await tx.user.delete({ where: { id: user.id } });
    });

    console.log(`✅ Successfully wiped account "${user.username}" for a completely fresh start!`);
  }
}

main()
  .catch((e) => {
    console.error('❌ Error resetting user:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
