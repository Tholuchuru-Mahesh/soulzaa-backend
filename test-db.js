const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const packages = await prisma.coinPackage.findMany();
  console.log(packages.map(p => ({
    ...p,
    coins: p.coins.toString(),
    bonusCoins: p.bonusCoins.toString(),
    priceAmount: p.priceAmount.toString()
  })));
}
main().catch(console.error).finally(() => prisma.$disconnect());
