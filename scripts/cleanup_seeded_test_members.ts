import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

const prisma = new PrismaClient();
const TARGET_ROOM_ID = '41017523-8b36-4928-af8c-98cbd68aa918';

// The exact 20 usernames written by scripts/seed_live_test_users_and_messages.ts.
const SEEDED_USERNAMES = [
  'arjun_sharma', 'pooja_patel', 'rahul_verma', 'ananya_reddy', 'rohan_gupta',
  'sneha_rao', 'karan_malhotra', 'priya_nair', 'vikram_singh', 'neha_joshi',
  'aditya_kumar', 'divya_shah', 'suresh_raina', 'ritu_deshmukh', 'amit_trivedi',
  'kavya_menon', 'manish_pandey', 'sunita_iyer', 'deepak_chawla', 'swati_kulkarni',
];

async function main() {
  const users = await prisma.user.findMany({
    where: { username: { in: SEEDED_USERNAMES } },
    select: { id: true, username: true },
  });
  console.log(`Found ${users.length}/${SEEDED_USERNAMES.length} seeded test users in the DB.`);
  const userIds = users.map((u) => u.id);
  if (userIds.length === 0) {
    console.log('Nothing to clean up.');
    return;
  }

  const deactivated = await prisma.videoRoomMember.updateMany({
    where: { roomId: TARGET_ROOM_ID, userId: { in: userIds }, isActive: true },
    data: { isActive: false, memberStatus: 'LEFT', leftAt: new Date() },
  });
  console.log(`Deactivated ${deactivated.count} VideoRoomMember rows.`);

  const presenceDeleted = await prisma.videoRoomPresence.deleteMany({
    where: { roomId: TARGET_ROOM_ID, userId: { in: userIds } },
  });
  console.log(`Deleted ${presenceDeleted.count} VideoRoomPresence rows.`);

  const messagesDeleted = await prisma.videoRoomMessage.updateMany({
    where: { roomId: TARGET_ROOM_ID, senderId: { in: userIds }, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  console.log(`Soft-deleted ${messagesDeleted.count} chat messages from seeded test users.`);

  const remainingActive = await prisma.videoRoomMember.count({
    where: { roomId: TARGET_ROOM_ID, isActive: true },
  });
  console.log(`Remaining active members in room: ${remainingActive}`);

  // Clear the Redis chat cache and viewer-presence sets for this room so the
  // eye icon / recent-chat cache don't keep serving anything stale from the
  // seed script's direct Redis writes.
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  try {
    const redis = new Redis(redisUrl, { connectTimeout: 3000, maxRetriesPerRequest: 1 });
    for (const u of users) {
      await redis.srem(`video-room:{${TARGET_ROOM_ID}}:viewers`, u.id);
      await redis.srem(`video-room:{${TARGET_ROOM_ID}}:hosts`, u.id);
      await redis.srem(`video-room:{${TARGET_ROOM_ID}}:participants`, u.id);
    }
    await redis.del(`video-room:{${TARGET_ROOM_ID}}:chat:recent`);
    console.log('Cleared any matching Redis presence entries + chat cache for the room.');
    await redis.quit();
  } catch (err: any) {
    console.warn(`Could not connect to Redis (${err.message}) — Postgres is clean either way.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
