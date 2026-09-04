import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TARGET_ROOM_ID = '41017523-8b36-4928-af8c-98cbd68aa918';

async function main() {
  const allMembers = await prisma.videoRoomMember.findMany({
    where: { roomId: TARGET_ROOM_ID },
  });
  console.log(`Total videoRoomMember records for this room: ${allMembers.length}`);
  const activeMembers = allMembers.filter(m => m.isActive);
  console.log(`Active members: ${activeMembers.length}, Inactive: ${allMembers.length - activeMembers.length}`);
  for (const m of allMembers) {
    console.log(` - userId=${m.userId}, role=${m.role}, isActive=${m.isActive}, leftAt=${m.leftAt}`);
  }
}

main().finally(() => prisma.$disconnect());
