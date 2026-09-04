import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Searching for rooms...');

  const videoRooms = await prisma.videoRoom.findMany({
    take: 20,
    orderBy: { createdAt: 'desc' },
  });
  console.log(`\nFound ${videoRooms.length} VideoRooms:`);
  for (const r of videoRooms) {
    console.log(`VideoRoom: id=${r.id}, name="${r.name}", status=${r.status}, ownerId=${r.ownerId}`);
  }

  const audioRooms = await prisma.audioRoom.findMany({
    take: 20,
    orderBy: { createdAt: 'desc' },
  });
  console.log(`\nFound ${audioRooms.length} AudioRooms:`);
  for (const r of audioRooms) {
    console.log(`AudioRoom: id=${r.id}, name="${r.name}", status=${r.status}, ownerId=${r.ownerId}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
