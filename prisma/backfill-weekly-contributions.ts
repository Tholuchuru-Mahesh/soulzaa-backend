/**
 * One-time backfill of the per-ISO-week contribution buckets
 * (`room_weekly_contributions`, `user_weekly_contributions`) from the immutable
 * gift ledger (`gift_transactions`).
 *
 * Source of truth: every COMPLETED gift in an AUDIO_ROOM / VIDEO_ROOM context.
 *   - room bucket  → Σ total_coin_value grouped by (context_id, ISO week)
 *   - user bucket  → Σ total_coin_value grouped by (receiver_id, ISO week)  [coins RECEIVED]
 *
 * Nothing is fabricated — buckets are pure re-aggregations of existing ledger
 * rows. Idempotent: each (id, weekKey) is upserted to the computed sum, so
 * re-running converges to the same values. The legacy lifetime counters
 * (`*_contribution_counters`) are left untouched.
 *
 * Run:  npx ts-node -r tsconfig-paths/register prisma/backfill-weekly-contributions.ts
 */
import { PrismaClient } from '@prisma/client';
import { isoWeekWindowUtc } from '../src/common/utils/iso-week.util';

const prisma = new PrismaClient();

type Row = { week_key: string; entity_id: string; amount: bigint | null };

async function backfill(
  kind: 'room' | 'user',
): Promise<{ weeks: number; rows: number }> {
  const idCol = kind === 'room' ? '"contextId"' : '"receiverId"';

  // Postgres ISO week: IYYY + IW → matches src/common/utils/iso-week.util.ts's
  // `${isoYear}W${week2}` format exactly.
  const rows = await prisma.$queryRawUnsafe<Row[]>(`
    SELECT to_char("createdAt", 'IYYY') || 'W' || to_char("createdAt", 'IW') AS week_key,
           ${idCol}                                                          AS entity_id,
           SUM("totalCoinValue")                                             AS amount
    FROM gift_transactions
    WHERE status = 'COMPLETED'
      AND "contextType" IN ('AUDIO_ROOM', 'VIDEO_ROOM')
    GROUP BY 1, 2
  `);

  let count = 0;
  const weeks = new Set<string>();
  for (const r of rows) {
    if (!r.entity_id || !r.amount) continue;
    weeks.add(r.week_key);
    const { start, end } = isoWeekWindowUtc(r.week_key);
    const amount = BigInt(r.amount);

    if (kind === 'room') {
      await prisma.roomWeeklyContribution.upsert({
        where: { roomId_weekKey: { roomId: r.entity_id, weekKey: r.week_key } },
        create: {
          roomId: r.entity_id,
          weekKey: r.week_key,
          weekStart: start,
          weekEnd: end,
          amount,
        },
        update: { amount },
      });
    } else {
      await prisma.userWeeklyContribution.upsert({
        where: { userId_weekKey: { userId: r.entity_id, weekKey: r.week_key } },
        create: {
          userId: r.entity_id,
          weekKey: r.week_key,
          weekStart: start,
          weekEnd: end,
          amount,
        },
        update: { amount },
      });
    }
    count += 1;
    if (count % 500 === 0) console.log(`  …${count} ${kind} buckets`);
  }
  return { weeks: weeks.size, rows: count };
}

async function main(): Promise<void> {
  console.log('Backfilling weekly contribution buckets from gift_transactions…');
  const room = await backfill('room');
  console.log(`  rooms: ${room.rows} buckets across ${room.weeks} weeks`);
  const user = await backfill('user');
  console.log(`  users: ${user.rows} buckets across ${user.weeks} weeks`);
  console.log('Done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
