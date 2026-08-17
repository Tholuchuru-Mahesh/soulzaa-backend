const { PrismaClient } = require('@prisma/client');

async function run() {
  const prisma = new PrismaClient();
  try {
    const rooms = await prisma.audioRoom.findMany();
    console.log(`Total AudioRooms in DB: ${rooms.length}`);
    for (const r of rooms) {
      console.log(`ID: ${r.id} | Name: ${r.name} | Status: ${r.status} | OwnerID: ${r.ownerId}`);
    }
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
