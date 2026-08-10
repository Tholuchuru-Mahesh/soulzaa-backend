const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const packages = await prisma.coinPackage.findMany();
  
  for (const pkg of packages) {
    const googleId = `soulzaa_coins_${pkg.coins}`;
    console.log(`Updating ${pkg.code} with googleProductId: ${googleId}`);
    await prisma.coinPackage.update({
      where: { id: pkg.id },
      data: { googleProductId: googleId }
    });
  }
  console.log('Update complete!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
