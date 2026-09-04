import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

const prisma = new PrismaClient();

const TARGET_ROOM_ID = '41017523-8b36-4928-af8c-98cbd68aa918';

const TEST_USERS_DATA = [
  {
    username: 'arjun_sharma',
    fullName: 'Arjun Sharma',
    mobile: '+919800000001',
    message: 'Hey BhAAi! Super excited for this live! 🔥',
  },
  {
    username: 'pooja_patel',
    fullName: 'Pooja Patel',
    mobile: '+919800000002',
    message: 'Hello everyone! Great stream today! ❤️',
  },
  {
    username: 'rahul_verma',
    fullName: 'Rahul Verma',
    mobile: '+919800000003',
    message: 'Love the energy here 🎉',
  },
  {
    username: 'ananya_reddy',
    fullName: 'Ananya Reddy',
    mobile: '+919800000004',
    message: 'Can you do that again? 😂',
  },
  {
    username: 'rohan_gupta',
    fullName: 'Rohan Gupta',
    mobile: '+919800000005',
    message: 'Namaste BhAAi! Big fan from Hyderabad 🙏',
  },
  {
    username: 'sneha_rao',
    fullName: 'Sneha Rao',
    mobile: '+919800000006',
    message: 'Audio and video are so crisp! 💯',
  },
  {
    username: 'karan_malhotra',
    fullName: 'Karan Malhotra',
    mobile: '+919800000007',
    message: "Let's goooo! 🚀",
  },
  {
    username: 'priya_nair',
    fullName: 'Priya Nair',
    mobile: '+919800000008',
    message: 'Send some gifts guys! 🎁',
  },
  {
    username: 'vikram_singh',
    fullName: 'Vikram Singh',
    mobile: '+919800000009',
    message: 'Awesome stream today 🥳',
  },
  {
    username: 'neha_joshi',
    fullName: 'Neha Joshi',
    mobile: '+919800000010',
    message: 'Is this live every day? 🤩',
  },
  {
    username: 'aditya_kumar',
    fullName: 'Aditya Kumar',
    mobile: '+919800000011',
    message: 'King of live streams 👑',
  },
  {
    username: 'divya_shah',
    fullName: 'Divya Shah',
    mobile: '+919800000012',
    message: 'Hello from Bangalore! 👋',
  },
  {
    username: 'suresh_raina',
    fullName: 'Suresh Raina',
    mobile: '+919800000013',
    message: 'Nice vibe here ✨',
  },
  {
    username: 'ritu_deshmukh',
    fullName: 'Ritu Deshmukh',
    mobile: '+919800000014',
    message: 'Who is ready for PK battle? 🏆',
  },
  {
    username: 'amit_trivedi',
    fullName: 'Amit Trivedi',
    mobile: '+919800000015',
    message: 'Loving the chat reactions 😍',
  },
  {
    username: 'kavya_menon',
    fullName: 'Kavya Menon',
    mobile: '+919800000016',
    message: 'Cheers bro! 🍻',
  },
  {
    username: 'manish_pandey',
    fullName: 'Manish Pandey',
    mobile: '+919800000017',
    message: 'Can I join the stage next? 🎤',
  },
  {
    username: 'sunita_iyer',
    fullName: 'Sunita Iyer',
    mobile: '+919800000018',
    message: 'Best streamer ever 🌟',
  },
  {
    username: 'deepak_chawla',
    fullName: 'Deepak Chawla',
    mobile: '+919800000019',
    message: 'Keep rocking! 👏',
  },
  {
    username: 'swati_kulkarni',
    fullName: 'Swati Kulkarni',
    mobile: '+919800000020',
    message: 'Happy to be here with everyone! 💖',
  },
];

async function main() {
  console.log(`Checking target video room ID: ${TARGET_ROOM_ID}...`);
  const room = await prisma.videoRoom.findUnique({
    where: { id: TARGET_ROOM_ID },
  });

  if (!room) {
    throw new Error(`Video room ${TARGET_ROOM_ID} not found!`);
  }
  console.log(`Found Room: "${room.name}" (Status: ${room.status}, Owner: ${room.ownerId})`);

  // Ensure room is LIVE
  if (room.status !== 'LIVE') {
    console.log('Room is not LIVE. Updating status to LIVE...');
    await prisma.videoRoom.update({
      where: { id: room.id },
      data: { status: 'LIVE', endedAt: null },
    });
  }

  const maxUser = await prisma.user.findFirst({
    orderBy: { displayId: 'desc' },
    select: { displayId: true },
  });
  let nextDisplayId = (maxUser?.displayId ?? 100000) + 1;

  console.log(`\nNext displayId starts from: ${nextDisplayId}`);
  console.log('Activating 20 users as active members in the live room...');
  const seededUsers: Array<{ id: string; fullName: string; username: string; message: string }> = [];

  // Protect test users from background session monitor reclaim:
  // Set lastSeenAt and lastActiveAt 7 days into the future
  const futureHeartbeat = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  for (let i = 0; i < TEST_USERS_DATA.length; i++) {
    const item = TEST_USERS_DATA[i];

    // Find or create user
    let user = await prisma.user.findFirst({
      where: {
        OR: [{ username: item.username }, { mobile: item.mobile }],
      },
    });

    if (!user) {
      const displayId = nextDisplayId++;
      user = await prisma.user.create({
        data: {
          displayId,
          username: item.username,
          fullName: item.fullName,
          mobile: item.mobile,
          country: 'IN',
          preferredLanguage: 'en',
          mobileVerifiedAt: new Date(),
        },
      });

      await prisma.userProfile.create({
        data: {
          userId: user.id,
          bio: `Hello, I'm ${item.fullName}!`,
        },
      });
      await prisma.userStatistics.create({ data: { userId: user.id } });
      await prisma.userVerification.create({ data: { userId: user.id } });
      console.log(`Created user ${i + 1}/20: ${user.fullName} (@${user.username}) [${user.id}]`);
    } else {
      await prisma.user.update({
        where: { id: user.id },
        data: { fullName: item.fullName },
      });
      console.log(`Using existing user ${i + 1}/20: ${item.fullName} (@${user.username}) [${user.id}]`);
    }

    // 2. Ensure user is active VideoRoomMember (no leftAt, isActive = true)
    await prisma.videoRoomMember.upsert({
      where: {
        roomId_userId: {
          roomId: room.id,
          userId: user.id,
        },
      },
      create: {
        roomId: room.id,
        userId: user.id,
        role: 'VIEWER',
        isActive: true,
        leftAt: null,
        lastActiveAt: futureHeartbeat,
      },
      update: {
        isActive: true,
        leftAt: null,
        lastActiveAt: futureHeartbeat,
      },
    });

    // 3. Upsert VideoRoomPresence with future lastSeenAt so session monitor does NOT sweep them
    await prisma.videoRoomPresence.upsert({
      where: {
        roomId_userId: {
          roomId: room.id,
          userId: user.id,
        },
      },
      create: {
        roomId: room.id,
        userId: user.id,
        role: 'VIEWER',
        lastSeenAt: futureHeartbeat,
      },
      update: {
        lastSeenAt: futureHeartbeat,
      },
    });

    seededUsers.push({
      id: user.id,
      fullName: item.fullName,
      username: user.username ?? item.username,
      message: item.message,
    });
  }

  console.log(`\nAll 20 users are active members in room "${room.name}".`);

  // 4. Create 20 fresh chat messages with timestamps right now
  console.log('\nCreating 20 brand-new chat messages (latest timestamps)...');
  const now = Date.now();
  const createdMessages: any[] = [];

  for (let i = 0; i < seededUsers.length; i++) {
    const u = seededUsers[i];
    // Spaced by 1 second up to now so they are the newest items in the room
    const createdAt = new Date(now - (seededUsers.length - i) * 1000);

    const msg = await prisma.videoRoomMessage.create({
      data: {
        roomId: room.id,
        senderId: u.id,
        type: 'TEXT',
        content: u.message,
        createdAt,
      },
    });

    createdMessages.push({
      roomId: room.id,
      messageId: msg.id,
      senderId: u.id,
      senderName: u.fullName,
      username: u.username,
      type: 'TEXT',
      content: u.message,
      status: 'SENT',
      mentions: [],
      mentionScope: null,
      replyToId: null,
      createdAt: msg.createdAt.toISOString(),
    });
  }

  // 5. Update room statistics
  await prisma.videoRoomStatistics.upsert({
    where: { roomId: room.id },
    create: {
      roomId: room.id,
      currentViewers: 20,
      totalChatMessages: 20n,
    },
    update: {
      currentViewers: 20,
      totalChatMessages: { increment: 20n },
    },
  });

  // 6. Push to Redis recent buffer
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  console.log(`\nUpdating Redis cache at ${redisUrl}...`);
  try {
    const redis = new Redis(redisUrl, { connectTimeout: 3000, maxRetriesPerRequest: 1 });
    const cacheKey = `video-room:{${room.id}}:chat:recent`;

    // Clear existing cache and push latest 20 messages in reverse order (newest first for LPUSH)
    await redis.del(cacheKey);
    for (let i = createdMessages.length - 1; i >= 0; i--) {
      await redis.lpush(cacheKey, JSON.stringify(createdMessages[i]));
    }
    await redis.expire(cacheKey, 86400);
    console.log(`Successfully primed Redis ring buffer at "${cacheKey}" with 20 fresh messages.`);
    await redis.quit();
  } catch (err: any) {
    console.warn(`Could not connect to Redis (${err.message}), but Postgres database is fully updated.`);
  }

  console.log('\n======================================================');
  console.log('✅ SUCCESS! 20 users re-activated and 20 fresh messages created!');
  console.log(`Room Name: "${room.name}" (ID: ${room.id})`);
  console.log('======================================================');
  for (let i = 0; i < seededUsers.length; i++) {
    const u = seededUsers[i];
    console.log(`${i + 1}. [${u.fullName}] (@${u.username}) [ID: ${u.id}]: "${u.message}"`);
  }
  console.log('======================================================\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
