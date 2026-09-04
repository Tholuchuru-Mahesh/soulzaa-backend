import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TARGET_ROOM_ID = '41017523-8b36-4928-af8c-98cbd68aa918';

async function main() {
  const members = await prisma.videoRoomMember.findMany({
    where: { roomId: TARGET_ROOM_ID, isActive: true },
    include: {
      user: {
        select: { id: true, username: true, fullName: true },
      },
    },
  });
  console.log(`Currently ${members.length} active members:`);
  for (const m of members) {
    console.log(` - ${m.user.fullName} (@${m.user.username}) [${m.userId}] role=${m.role}`);
  }
}

main().finally(() => prisma.$disconnect());
