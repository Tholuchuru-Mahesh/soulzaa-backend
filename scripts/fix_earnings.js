const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const result = await prisma.$executeRawUnsafe(
    'UPDATE gift_transactions SET "creatorEarnings" = "totalCoinValue" WHERE status = \'COMPLETED\''
  );
  console.log(`Updated ${result} gift_transactions rows so creatorEarnings = totalCoinValue.`);

  const syncResult = await prisma.$executeRawUnsafe(`
    INSERT INTO creator_daily_stats ("id", "dateKey", "userId", "giftsReceivedCount", "giftCoinsReceived", "creatorEarnings", "roomsHosted", "speakingSeconds", "engagementScore", "createdAt", "updatedAt")
    SELECT 
      gen_random_uuid(),
      TO_CHAR("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "dateKey",
      "receiverId" AS "userId",
      COUNT(*)::integer AS "giftsReceivedCount",
      SUM("totalCoinValue") AS "giftCoinsReceived",
      SUM("totalCoinValue") AS "creatorEarnings",
      0 AS "roomsHosted",
      0 AS "speakingSeconds",
      0 AS "engagementScore",
      NOW(),
      NOW()
    FROM gift_transactions
    WHERE status = 'COMPLETED'
    GROUP BY "receiverId", TO_CHAR("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD')
    ON CONFLICT ("dateKey", "userId") DO UPDATE SET
      "giftCoinsReceived" = EXCLUDED."giftCoinsReceived",
      "creatorEarnings" = EXCLUDED."creatorEarnings",
      "giftsReceivedCount" = EXCLUDED."giftsReceivedCount",
      "updatedAt" = NOW();
  `);
  console.log(`Synced creator_daily_stats table (${syncResult} rows).`);
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
