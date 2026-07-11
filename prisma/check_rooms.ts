import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

async function main() {
  // 1. Get or create a test user to own the room
  let dbUser = await prisma.user.findFirst();
  let user: any;

  if (!dbUser) {
    console.log('No user found! Creating a test user first...');
    const mobile = '+919030996071';
    const username = 'testuser';
    user = await prisma.$transaction(async (tx: any) => {
      const u = await tx.user.create({
        data: {
          username,
          mobile,
          fullName: 'Test User',
          country: 'IN',
          preferredLanguage: 'en',
          mobileVerifiedAt: new Date(),
        }
      });
      await tx.userProfile.create({ data: { userId: u.id } });
      await tx.userStatistics.create({ data: { userId: u.id } });
      await tx.userVerification.create({ data: { userId: u.id } });
      return u;
    });
    console.log(`Created test user: ${user.id}`);
  } else {
    user = dbUser;
    console.log(`Using existing user: ${user.id} (${user.username})`);
  }

  // 2. Get or create a category
  let category = await prisma.roomCategory.findFirst();
  if (!category) {
    console.log('No room category found! Creating one...');
    category = await prisma.roomCategory.create({
      data: {
        name: 'Chat & Friends',
        slug: 'chat',
        sortOrder: 1,
        isActive: true,
      }
    });
  }
  console.log(`Using category: ${category.id} (${category.name})`);

  // 3. Check for live rooms
  const liveRooms = await prisma.audioRoom.findMany({
    where: { status: 'LIVE' }
  });

  console.log(`Found ${liveRooms.length} live rooms in DB.`);

  if (liveRooms.length === 0) {
    console.log('Creating a default live audio room for testing...');
    const roomId = randomUUID();
    const agoraChannel = `room_${roomId.substring(0, 8)}`;
    const zegoRoomId = `zego_${roomId.substring(0, 8)}`;

    const room = await prisma.$transaction(async (tx: any) => {
      const r = await tx.audioRoom.create({
        data: {
          id: roomId,
          ownerId: user.id,
          name: 'Welcome to Soulzaa! 🎉',
          description: 'A cozy space to hang out, chat, and listen to music.',
          categoryId: category.id,
          language: 'en',
          visibility: 'PUBLIC',
          maxParticipants: 50,
          status: 'LIVE',
          agoraChannel,
          zegoRoomId,
        }
      });

      await tx.roomSettings.create({
        data: {
          roomId: r.id,
          speakerSeatCount: 8,
          premiumAdminSeatCount: 0,
        }
      });

      await tx.roomMember.create({
        data: {
          roomId: r.id,
          userId: user.id,
          role: 'OWNER',
          isActive: true,
        }
      });

      return r;
    });

    console.log(`Successfully created live room: ${room.id}`);
    console.log(`agoraChannel: ${room.agoraChannel}, zegoRoomId: ${room.zegoRoomId}`);
  } else {
    console.log('Live rooms present:');
    for (const r of liveRooms) {
      console.log(`- Room "${r.name}" (${r.id}), owner: ${r.ownerId}, status: ${r.status}`);
    }
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
