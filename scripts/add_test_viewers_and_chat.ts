import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

const prisma = new PrismaClient();
const TARGET_ROOM_ID = '41017523-8b36-4928-af8c-98cbd68aa918';

// Reuse 5 of the same test accounts from the earlier seed script — they
// already exist, so this just reactivates their membership properly through
// every layer the real join flow touches (Postgres member + presence, Redis
// viewer set, the cached state snapshot), instead of only writing the DB
// rows the way the old script did.
const TEST_USERS = [
  { username: 'arjun_sharma', message: 'Hey BhAAi! Excited for this live! 🔥' },
  { username: 'pooja_patel', message: 'Hello everyone! Great stream today! ❤️' },
  { username: 'rahul_verma', message: 'Love the energy here 🎉' },
  { username: 'ananya_reddy', message: 'Can you do that again? 😂' },
  { username: 'rohan_gupta', message: 'Namaste BhAAi! Big fan 🙏' },
];

async function main() {
  const room = await prisma.videoRoom.findUnique({ where: { id: TARGET_ROOM_ID } });
  if (!room) throw new Error('Room not found');
  console.log(`Room "${room.name}" (${room.status})`);

  const users = await prisma.user.findMany({
    where: { username: { in: TEST_USERS.map((u) => u.username) } },
  });
  const byUsername = new Map(users.map((u) => [u.username, u]));

  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const redis = new Redis(redisUrl, { connectTimeout: 3000, maxRetriesPerRequest: 1 });

  const now = new Date();
  const addedUserIds: string[] = [];

  for (const t of TEST_USERS) {
    const user = byUsername.get(t.username);
    if (!user) {
      console.warn(`Skipping ${t.username} — user not found.`);
      continue;
    }

    await prisma.videoRoomMember.upsert({
      where: { roomId_userId: { roomId: room.id, userId: user.id } },
      create: {
        roomId: room.id,
        userId: user.id,
        role: 'VIEWER',
        memberStatus: 'ACTIVE',
        isActive: true,
        joinedAt: now,
        lastActiveAt: now,
      },
      update: {
        role: 'VIEWER',
        memberStatus: 'ACTIVE',
        isActive: true,
        leftAt: null,
        lastActiveAt: now,
      },
    });

    await prisma.videoRoomPresence.upsert({
      where: { roomId_userId: { roomId: room.id, userId: user.id } },
      create: { roomId: room.id, userId: user.id, role: 'VIEWER', lastSeenAt: now },
      update: { lastSeenAt: now },
    });

    await redis.sadd(`video-room:{${room.id}}:viewers`, user.id);
    addedUserIds.push(user.id);

    const msg = await prisma.videoRoomMessage.create({
      data: {
        roomId: room.id,
        senderId: user.id,
        type: 'TEXT',
        content: t.message,
        createdAt: new Date(now.getTime() + addedUserIds.length * 500),
      },
    });

    // Keep the recent-chat Redis cache in sync so a client reading from
    // cache sees these messages immediately too.
    await redis.lpush(
      `video-room:{${room.id}}:chat:recent`,
      JSON.stringify({
        roomId: room.id,
        messageId: msg.id,
        senderId: user.id,
        senderName: user.fullName ?? user.username,
        username: user.username,
        type: 'TEXT',
        content: t.message,
        status: 'SENT',
        mentions: [],
        mentionScope: null,
        replyToId: null,
        createdAt: msg.createdAt.toISOString(),
      }),
    );

    console.log(`Added ${user.fullName ?? user.username} as an active viewer + 1 chat message.`);
  }

  // Bring the cached live-count snapshot in line with the real Redis viewer
  // set, the same thing a real join's `state.applyUpdate` would do — without
  // this, `counts.viewers` in the sync payload keeps serving whatever number
  // was cached before (possibly 0/null), not the count we just created.
  const totalViewers = await redis.scard(`video-room:{${room.id}}:viewers`);
  const stateKey = `video-room:{${room.id}}:state`;
  const existingStateRaw = await redis.get(stateKey);
  const existingState = existingStateRaw ? JSON.parse(existingStateRaw) : null;
  const nextState = {
    roomId: room.id,
    version: (existingState?.version ?? 0) + 1,
    status: room.status,
    participantCount: existingState?.participantCount ?? 0,
    viewerCount: totalViewers,
    hostCount: existingState?.hostCount ?? 0,
    onlineCount: totalViewers,
    reconnectingCount: 0,
    idleCount: 0,
    isLocked: room.isLocked,
    updatedAt: now.toISOString(),
  };
  await redis.set(stateKey, JSON.stringify(nextState), 'EX', 21600);
  console.log('Updated cached state snapshot:', nextState);

  await prisma.videoRoomStatistics.upsert({
    where: { roomId: room.id },
    create: { roomId: room.id, currentViewers: totalViewers },
    update: { currentViewers: totalViewers },
  });

  console.log(`\nDone. ${addedUserIds.length} test viewers added, ${addedUserIds.length} chat messages sent.`);
  console.log(`Total Redis viewers now: ${totalViewers}`);
  await redis.quit();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
