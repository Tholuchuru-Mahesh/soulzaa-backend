import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const vRooms = await prisma.videoRoom.findMany({
    where: { name: { contains: 'bhais', mode: 'insensitive' } },
    select: { id: true, name: true, status: true },
  });
  console.log('Video Rooms:', vRooms);

  const aRooms = await prisma.audioRoom.findMany({
    where: { name: { contains: 'bhais', mode: 'insensitive' } },
    select: { id: true, name: true, status: true },
  });
  console.log('Audio Rooms:', aRooms);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
