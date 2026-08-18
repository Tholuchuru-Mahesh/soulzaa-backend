const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    const giftTxs = await prisma.giftTransaction.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10
    });

    console.log(`FOUND ${giftTxs.length} GIFT TRANSACTIONS IN SYSTEM:`);
    const txnId = '3ac5151e-65f6-4820-9e92-2bd37b27e52d';
    const tx = await prisma.walletTransaction.findUnique({
      where: { id: txnId },
      include: {
        ledgerEntries: true
      }
    });

    console.log('SPECIFIC TRANSACTION:', JSON.stringify(tx, (key, value) => {
      if (typeof value === 'bigint') return value.toString();
      return value;
    }, 2));
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
