const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const states = await prisma.state.findMany();
  console.log('STATES:', states);

  const regions = await prisma.region.findMany();
  console.log('REGIONS:', regions);

  const countries = await prisma.country.findMany();
  console.log('COUNTRIES:', countries);

  const officials = await prisma.user.findMany({
    where: {
      OR: [
        { username: { contains: 'official', mode: 'insensitive' } },
        { username: { contains: 'e2e', mode: 'insensitive' } },
        { username: 'Anna' }
      ]
    },
    include: {
      locationCountry: true,
      locationState: true,
      locationRegion: true,
    }
  });
  console.log('OFFICIAL_USERS:', JSON.stringify(officials, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
