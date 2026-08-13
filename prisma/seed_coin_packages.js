const { PrismaClient } = require('@prisma/client');

async function run() {
  const prisma = new PrismaClient();
  try {
    console.log('Seeding coin packages...');
    
    const packages = [
      {
        code: 'IN_GOLD_100',
        name: '100 Coins',
        coins: 100n,
        bonusCoins: 0n,
        priceAmount: 89.00,
        currency: 'INR',
        country: 'GLOBAL',
        platform: 'ALL',
        googleProductId: 'in_gold_100',
        isActive: true,
        sortOrder: 1,
      },
      {
        code: 'IN_GOLD_500',
        name: '500 Coins',
        coins: 500n,
        bonusCoins: 50n,
        priceAmount: 449.00,
        currency: 'INR',
        country: 'GLOBAL',
        platform: 'ALL',
        googleProductId: 'in_gold_500',
        isActive: true,
        sortOrder: 2,
      },
      {
        code: 'IN_GOLD_1000',
        name: '1,000 Coins',
        coins: 1000n,
        bonusCoins: 120n,
        priceAmount: 899.00,
        currency: 'INR',
        country: 'GLOBAL',
        platform: 'ALL',
        googleProductId: 'in_gold_1000',
        isActive: true,
        sortOrder: 3,
      },
      {
        code: 'IN_GOLD_5000',
        name: '5,000 Coins',
        coins: 5000n,
        bonusCoins: 750n,
        priceAmount: 4499.00,
        currency: 'INR',
        country: 'GLOBAL',
        platform: 'ALL',
        googleProductId: 'in_gold_5000',
        isActive: true,
        sortOrder: 4,
      },
      {
        code: 'IN_GOLD_10000',
        name: '10,000 Coins',
        coins: 10000n,
        bonusCoins: 2000n,
        priceAmount: 8999.00,
        currency: 'INR',
        country: 'GLOBAL',
        platform: 'ALL',
        googleProductId: 'in_gold_10000',
        isActive: true,
        sortOrder: 5,
      }
    ];

    for (const pkg of packages) {
      const created = await prisma.coinPackage.upsert({
        where: { code: pkg.code },
        update: {
          name: pkg.name,
          coins: pkg.coins,
          bonusCoins: pkg.bonusCoins,
          priceAmount: pkg.priceAmount,
          currency: pkg.currency,
          country: pkg.country,
          platform: pkg.platform,
          googleProductId: pkg.googleProductId,
          isActive: pkg.isActive,
          sortOrder: pkg.sortOrder,
        },
        create: {
          code: pkg.code,
          name: pkg.name,
          coins: pkg.coins,
          bonusCoins: pkg.bonusCoins,
          priceAmount: pkg.priceAmount,
          currency: pkg.currency,
          country: pkg.country,
          platform: pkg.platform,
          googleProductId: pkg.googleProductId,
          isActive: pkg.isActive,
          sortOrder: pkg.sortOrder,
        }
      });
      console.log(`Upserted package: ${created.code} (${created.name})`);
    }

    console.log('✅ Seeding completed successfully!');
  } catch (error) {
    console.error('Error during seeding:', error);
  } finally {
    await prisma.$disconnect();
  }
}

run();
