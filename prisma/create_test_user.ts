import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const mobile = '+919030996071';
  const username = 'testuser';

  const existing = await prisma.user.findFirst({
    where: {
      OR: [{ mobile }, { username }],
    },
  });

  if (existing) {
    console.log(`User already exists: ${JSON.stringify(existing)}`);
    return;
  }

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        username,
        mobile,
        fullName: 'Test User',
        country: 'IN',
        preferredLanguage: 'en',
        mobileVerifiedAt: new Date(),
      },
    });

    await tx.userProfile.create({ data: { userId: user.id } });
    await tx.userStatistics.create({ data: { userId: user.id } });
    await tx.userVerification.create({ data: { userId: user.id } });

    console.log(`Test user successfully created: ${user.id}`);
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
