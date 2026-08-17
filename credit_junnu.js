const { PrismaClient } = require('@prisma/client');

async function run() {
  const prisma = new PrismaClient();
  try {
    console.log('🚀 Crediting 10 Lakhs (1,000,000 Gold Coins) to testing accounts & Junnu...');

    // 1. Find or create user junnu
    let junnuUser = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { contains: 'junnu', mode: 'insensitive' } },
          { email: { contains: 'junnu', mode: 'insensitive' } }
        ]
      }
    });

    if (!junnuUser) {
      console.log('Creating new user "junnu"...');
      junnuUser = await prisma.user.create({
        data: {
          username: 'junnu',
          email: 'junnu@soulzaa.com',
          fullName: 'Junnu',
          roles: ['USER']
        }
      });
      console.log(`Created user junnu with ID: ${junnuUser.id}`);
    }

    // List of target users to credit 10 Lakhs (1,000,000 coins)
    const targetUsers = await prisma.user.findMany({
      where: {
        OR: [
          { id: junnuUser.id },
          { username: 'Anna' },
          { username: 'swapnapothiredd' },
          { username: 'pothireddylucky' }
        ]
      }
    });

    for (const u of targetUsers) {
      const wallet = await prisma.wallet.upsert({
        where: { userId: u.id },
        update: {
          goldBalance: { increment: 1000000n }
        },
        create: {
          userId: u.id,
          goldBalance: 1000000n,
          freeBalance: 0n,
          earningsBalance: 0n,
          totalRecharged: 1000000n,
          totalSpent: 0n,
          totalGiftsSentValue: 0n,
          totalGiftsReceivedValue: 0n
        }
      });

      console.log(`✅ [CREDITED] User: ${u.username} (${u.fullName || u.email}) | +1,000,000 coins | Total Balance: ${wallet.goldBalance.toString()}`);
    }
  } catch (err) {
    console.error('Error crediting coins:', err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
