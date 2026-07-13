const { PrismaClient } = require('@prisma/client');

async function run() {
  const prisma = new PrismaClient();
  try {
    const user1 = await prisma.user.findUnique({ where: { username: 'pothireddy172' } });
    const user2 = await prisma.user.findUnique({ where: { username: 'swapnapothiredd' } });

    if (user1) {
      await prisma.wallet.upsert({
        where: { userId: user1.id },
        update: { goldBalance: 1000000n, freeBalance: 0n, earningsBalance: 0n, totalRecharged: 1000000n, totalSpent: 0n, totalGiftsSentValue: 0n, totalGiftsReceivedValue: 0n },
        create: { userId: user1.id, goldBalance: 1000000n, freeBalance: 0n, earningsBalance: 0n, totalRecharged: 1000000n, totalSpent: 0n, totalGiftsSentValue: 0n, totalGiftsReceivedValue: 0n }
      });
      console.log(`✅ pothireddy172 → 1,000,000 gold coins`);
    }

    if (user2) {
      await prisma.wallet.upsert({
        where: { userId: user2.id },
        update: { goldBalance: 0n, freeBalance: 0n, earningsBalance: 0n, totalRecharged: 0n, totalSpent: 0n, totalGiftsSentValue: 0n, totalGiftsReceivedValue: 0n },
        create: { userId: user2.id, goldBalance: 0n, freeBalance: 0n, earningsBalance: 0n, totalRecharged: 0n, totalSpent: 0n, totalGiftsSentValue: 0n, totalGiftsReceivedValue: 0n }
      });
      console.log(`✅ swapnapothiredd → 0 gold coins`);
    }

    await prisma.giftTransaction.deleteMany({});
    await prisma.userContributionCounter.deleteMany({});
    await prisma.treasureReward.deleteMany({});
    await prisma.treasureContribution.deleteMany({});
    await prisma.treasureBox.updateMany({ data: { status: 'PENDING', progress: 0n, topGifters: null, openedAt: null } });
    await prisma.treasureSession.deleteMany({});
    console.log('✅ All transactions, contributions, rewards, and treasure sessions cleared.');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

run();
