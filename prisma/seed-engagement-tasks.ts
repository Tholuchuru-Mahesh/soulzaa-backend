import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_TASKS = [
  {
    code: 'DAILY_LOGIN',
    name: 'Daily Attendance Login',
    category: 'DAILY_TASK',
    objective: 'Log in to Soulzaa to maintain your daily streak',
    requiredProgress: 1,
    eventCode: 'user.logged_in',
    resetPolicy: 'DAILY',
    difficulty: 'EASY',
    rewardDefinition: { freeCoins: 100, exp: 50 },
  },
  {
    code: 'JOIN_ROOMS_DAILY',
    name: 'Join 2 Live Rooms',
    category: 'DAILY_TASK',
    objective: 'Join 2 audio or video rooms today',
    requiredProgress: 2,
    eventCode: 'audio_room.joined',
    resetPolicy: 'DAILY',
    difficulty: 'EASY',
    rewardDefinition: { freeCoins: 200, exp: 100 },
  },
  {
    code: 'ROOM_STAY_20MIN',
    name: 'Stay 20 Minutes in Room',
    category: 'DAILY_TASK',
    objective: 'Spend 20 minutes hanging out in live voice or video rooms',
    requiredProgress: 20,
    eventCode: 'room.duration_updated',
    incrementField: 'durationMinutes',
    resetPolicy: 'DAILY',
    difficulty: 'MEDIUM',
    rewardDefinition: { freeCoins: 500, exp: 250, frameId: 'frame-bronze' },
  },
  {
    code: 'RECHARGE_COINS_DAILY',
    name: 'Coin Recharge Quest',
    category: 'DAILY_TASK',
    objective: 'Recharge or receive 500 coins today',
    requiredProgress: 500,
    eventCode: 'wallet.credited',
    incrementField: 'amount',
    resetPolicy: 'DAILY',
    difficulty: 'MEDIUM',
    rewardDefinition: { freeCoins: 1000, exp: 500, goldCoins: 50 },
  },
  {
    code: 'SEND_GIFTS_DAILY',
    name: 'Send 3 Virtual Gifts',
    category: 'DAILY_TASK',
    objective: 'Send 3 gifts to hosts or friends in live rooms',
    requiredProgress: 3,
    eventCode: 'gift.sent',
    resetPolicy: 'DAILY',
    difficulty: 'MEDIUM',
    rewardDefinition: { freeCoins: 300, exp: 150, themeId: 'theme-neon' },
  },
  {
    code: 'RECEIVE_GIFTS_DAILY',
    name: 'Receive 2 Virtual Gifts',
    category: 'DAILY_TASK',
    objective: 'Receive 2 gifts from audience or friends in room',
    requiredProgress: 2,
    eventCode: 'gift.received',
    resetPolicy: 'DAILY',
    difficulty: 'MEDIUM',
    rewardDefinition: { freeCoins: 400, exp: 200, badgeId: 'badge-star-host' },
  },
  {
    code: 'ADD_FRIENDS_WEEKLY',
    name: 'Add 2 New Friends',
    category: 'WEEKLY_MISSION',
    objective: 'Connect and add 2 new friends on Soulzaa',
    requiredProgress: 2,
    eventCode: 'social.friend.accepted',
    resetPolicy: 'WEEKLY',
    difficulty: 'EASY',
    rewardDefinition: { freeCoins: 1000, exp: 500, bubbleId: 'bubble-stars' },
  },
  {
    code: 'FOLLOW_CREATORS_WEEKLY',
    name: 'Follow 3 Creators',
    category: 'WEEKLY_MISSION',
    objective: 'Follow 3 hosts or creators on the platform',
    requiredProgress: 3,
    eventCode: 'social.followed',
    resetPolicy: 'WEEKLY',
    difficulty: 'EASY',
    rewardDefinition: { freeCoins: 600, exp: 300 },
  },
  {
    code: 'PLAY_GAMES_DAILY',
    name: 'Play 2 Mini-Games',
    category: 'DAILY_TASK',
    objective: 'Participate in 2 games (Lucky Fruit, Casino, etc.)',
    requiredProgress: 2,
    eventCode: 'game.settled',
    resetPolicy: 'DAILY',
    difficulty: 'EASY',
    rewardDefinition: { freeCoins: 500, exp: 250 },
  },
  {
    code: 'FAMILY_QUEST_WEEKLY',
    name: 'Family Community Quest',
    category: 'WEEKLY_MISSION',
    objective: 'Engage with your family or welcome a new member',
    requiredProgress: 1,
    eventCode: 'family.member_joined',
    resetPolicy: 'WEEKLY',
    difficulty: 'HARD',
    rewardDefinition: { freeCoins: 1500, exp: 800, entranceEffectId: 'ride-sports-car' },
  },
];

async function main() {
  console.log('Seeding standard engagement tasks for all triggering event types...');

  for (const t of DEFAULT_TASKS) {
    const progressRules: Record<string, any> = {
      eventCodes: [t.eventCode.toLowerCase(), t.eventCode],
      ...(t.incrementField ? { incrementField: t.incrementField } : {}),
      operator: 'ANY',
    };

    const result = await prisma.taskDefinition.upsert({
      where: { code: t.code },
      update: {
        name: t.name,
        category: t.category,
        objective: t.objective,
        requiredProgress: t.requiredProgress,
        resetPolicy: t.resetPolicy,
        difficulty: t.difficulty,
        status: 'ACTIVE',
        progressRules,
        rewardDefinition: t.rewardDefinition,
      },
      create: {
        code: t.code,
        name: t.name,
        category: t.category,
        objective: t.objective,
        requiredProgress: t.requiredProgress,
        resetPolicy: t.resetPolicy,
        difficulty: t.difficulty,
        status: 'ACTIVE',
        visibility: 'PUBLIC',
        priority: 10,
        repeatable: true,
        maxCompletions: 1,
        progressRules,
        rewardDefinition: t.rewardDefinition,
      },
    });

    console.log(`✓ Seeded Task: [${result.code}] ${result.name} (Trigger: ${t.eventCode})`);
  }

  console.log(`Successfully seeded ${DEFAULT_TASKS.length} tasks.`);
}

main()
  .catch((e) => {
    console.error('Failed to seed tasks:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
