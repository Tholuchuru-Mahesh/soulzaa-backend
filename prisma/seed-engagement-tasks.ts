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
    rewardDefinition: {
      freeCoins: 100,
      exp: 50,
      items: [
        { type: 'COINS', amount: 100 },
        { type: 'EXP', amount: 50 },
      ],
    },
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
    rewardDefinition: {
      freeCoins: 200,
      exp: 100,
      items: [
        { type: 'COINS', amount: 200 },
        { type: 'EXP', amount: 100 },
      ],
    },
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
    rewardDefinition: {
      freeCoins: 500,
      exp: 250,
      frameId: 'frame-bronze',
      frameDurationDays: 7,
      items: [
        { type: 'COINS', amount: 500 },
        { type: 'EXP', amount: 250 },
        { type: 'FRAME', cosmeticId: 'frame-bronze', durationDays: 7 },
      ],
    },
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
    rewardDefinition: {
      freeCoins: 1000,
      exp: 500,
      goldCoins: 50,
      vipDays: 1,
      items: [
        { type: 'COINS', amount: 1000 },
        { type: 'GOLD', amount: 50 },
        { type: 'EXP', amount: 500 },
        { type: 'VIP', vipDays: 1 },
      ],
    },
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
    rewardDefinition: {
      freeCoins: 300,
      exp: 150,
      themeId: 'theme-neon',
      themeDurationDays: 30,
      items: [
        { type: 'COINS', amount: 300 },
        { type: 'EXP', amount: 150 },
        { type: 'THEME', cosmeticId: 'theme-neon', durationDays: 30 },
      ],
    },
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
    rewardDefinition: {
      freeCoins: 400,
      exp: 200,
      badgeId: 'badge-star-host',
      items: [
        { type: 'COINS', amount: 400 },
        { type: 'EXP', amount: 200 },
        { type: 'BADGE', cosmeticId: 'badge-star-host' },
      ],
    },
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
    rewardDefinition: {
      freeCoins: 1000,
      exp: 500,
      bubbleId: 'bubble-stars',
      bubbleDurationDays: 7,
      items: [
        { type: 'COINS', amount: 1000 },
        { type: 'EXP', amount: 500 },
        { type: 'BUBBLE', cosmeticId: 'bubble-stars', durationDays: 7 },
      ],
    },
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
    rewardDefinition: {
      freeCoins: 600,
      exp: 300,
      items: [
        { type: 'COINS', amount: 600 },
        { type: 'EXP', amount: 300 },
      ],
    },
  },
  {
    code: 'PLAY_GAMES_DAILY',
    name: 'Play 2 Mini-Games',
    category: 'DAILY_TASK',
    objective: 'Participate in 2 games (Carrom, Ludo, etc.)',
    requiredProgress: 2,
    eventCode: 'game.settled',
    resetPolicy: 'DAILY',
    difficulty: 'EASY',
    progressRules: {
      eventCodes: ['game.settled', 'game.started', 'game.lobby_joined'],
      operator: 'ANY',
    },
    rewardDefinition: {
      gameCoins: 500,
      exp: 250,
      items: [
        { type: 'GAME_COINS', amount: 500 },
        { type: 'EXP', amount: 250 },
      ],
    },
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
    rewardDefinition: {
      freeCoins: 1500,
      exp: 800,
      entranceEffectId: 'ride-sports-car',
      entranceDurationDays: 14,
      items: [
        { type: 'COINS', amount: 1500 },
        { type: 'EXP', amount: 800 },
        { type: 'ENTRANCE_EFFECT', cosmeticId: 'ride-sports-car', durationDays: 14 },
      ],
    },
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
