/**
 * One-time (idempotent) cleanup: disable the six dead games removed from the
 * catalog (GAME_CATALOG_SEED now only lists LUDO + CARROM). Existing rows are
 * DISABLED (enabled=false), not deleted — GameSession/GameTransaction rows for
 * these codes may already reference their GameDefinition.id, and `enabled` is
 * exactly what listCatalog()/GET /games already filters on. Safe to re-run.
 */
import { GameCode, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEAD_GAMES: GameCode[] = [
  GameCode.GREEDY,
  GameCode.JACKPOT,
  GameCode.ROULETTE,
  GameCode.SLOTS,
  GameCode.DOMINO,
  GameCode.UNO,
];

async function main() {
  const result = await prisma.gameDefinition.updateMany({
    where: { code: { in: DEAD_GAMES } },
    data: { enabled: false },
  });
  console.log(`Disabled ${result.count} dead game definition row(s).`);

  const remaining = await prisma.gameDefinition.findMany({
    where: { enabled: true },
    select: { code: true, name: true },
    orderBy: { code: 'asc' },
  });
  console.log(
    'Enabled catalog now:',
    remaining.map((d) => `${d.code} (${d.name})`).join(', ') || '(none)',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
