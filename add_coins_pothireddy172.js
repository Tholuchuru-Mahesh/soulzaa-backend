const { PrismaClient } = require('@prisma/client');

async function run() {
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: 'pothireddy172' },
          { mobile: { contains: 'pothireddy172' } },
          { email: { contains: 'pothireddy172' } }
        ]
      }
    });

    if (!user) {
      console.error('❌ User pothireddy172 not found!');
      return;
    }

    console.log(`Found user: ${user.id} (${user.username || user.mobile || user.email})`);

    const wallet = await prisma.wallet.upsert({
      where: { userId: user.id },
      update: {
        goldBalance: 1000000n,
        availableBalance: 1000000n,
        totalRecharged: 1000000n
      },
      create: {
        userId: user.id,
        goldBalance: 1000000n,
        availableBalance: 1000000n,
        freeBalance: 0n,
        earningsBalance: 0n,
        totalRecharged: 1000000n,
        totalSpent: 0n,
        totalGiftsSentValue: 0n,
        totalGiftsReceivedValue: 0n
      }
    });

    console.log(`✅ Success! Updated wallet for ${user.username || user.id}:`);
    console.log(`   Gold Balance: ${wallet.goldBalance.toString()} GOLD coins (10 Lakhs)`);
    console.log(`   Available Balance: ${wallet.availableBalance.toString()}`);
  } catch (error) {
    console.error('❌ Error updating wallet:', error);
  } finally {
    await prisma.$disconnect();
  }
}

run();
