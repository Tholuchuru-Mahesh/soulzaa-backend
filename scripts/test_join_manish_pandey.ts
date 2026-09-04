import { PrismaClient, VideoRoomBlockType, VideoRoomModerationStatus } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();
const TARGET_ROOM_ID = '41017523-8b36-4928-af8c-98cbd68aa918';

async function main() {
  const user = await prisma.user.findFirst({
    where: { username: 'manish_pandey' },
  });

  if (!user) {
    console.error('Manish Pandey not found!');
    return;
  }

  console.log(`Manish Pandey found: ${user.fullName} (${user.id})`);

  // 1. Ensure he has an ACTIVE block in the room
  const existingBlock = await prisma.videoRoomBlock.findFirst({
    where: { roomId: TARGET_ROOM_ID, userId: user.id },
  });

  if (existingBlock) {
    console.log(`Updating existing block ${existingBlock.id} to ACTIVE...`);
    await prisma.videoRoomBlock.update({
      where: { id: existingBlock.id },
      data: {
        status: VideoRoomModerationStatus.ACTIVE,
        liftedAt: null,
        liftedBy: null,
      },
    });
  } else {
    console.log('Creating new ACTIVE block for Manish Pandey...');
    await prisma.videoRoomBlock.create({
      data: {
        roomId: TARGET_ROOM_ID,
        userId: user.id,
        moderatorId: '72ef41bc-491a-41a9-86fe-596899d7c7bf',
        type: VideoRoomBlockType.PERMANENT,
        reason: 'Banned by host for testing',
        status: VideoRoomModerationStatus.ACTIVE,
        createdBy: '72ef41bc-491a-41a9-86fe-596899d7c7bf',
        updatedBy: '72ef41bc-491a-41a9-86fe-596899d7c7bf',
      },
    });
  }

  // Also verify Redis mirror if Redis is active
  const redisKey = `video-room:{${TARGET_ROOM_ID}}:blocks`;
  try {
    const Redis = require('ioredis');
    const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
    await redis.sadd(redisKey, user.id);
    await redis.quit();
    console.log(`Added Manish Pandey to Redis blocked set: ${redisKey}`);
  } catch (e: any) {
    console.warn(`Redis update skipped: ${e.message}`);
  }

  console.log('\n--- SIMULATING MANISH PANDEY JOINING THE ROOM ---');

  // Let's check what VideoRoomMemberService.join checks:
  // 1. Is room live?
  const room = await prisma.videoRoom.findUnique({ where: { id: TARGET_ROOM_ID } });
  console.log(`Room status: ${room?.status}`);

  // 2. Is actively blocked?
  const activeBlock = await prisma.videoRoomBlock.findFirst({
    where: {
      roomId: TARGET_ROOM_ID,
      userId: user.id,
      status: VideoRoomModerationStatus.ACTIVE,
    },
  });

  console.log('Active block record:', activeBlock);

  if (activeBlock) {
    console.log('\n❌ JOIN REJECTED!');
    console.log('HTTP Status Code: 403 Forbidden');
    console.log('Backend Error Code: "VIDEO_ROOM_BLOCKED"');
    console.log('Backend Error Message: "You are blocked from this room."');
    console.log('Client Displays: "You have been banned from this room." (or "You are blocked from this room.")');
  } else {
    console.log('✅ Not blocked');
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
