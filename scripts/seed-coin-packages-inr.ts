/**
 * Seeds the official (in-app) INR coin panel from the Soulzaaa Coin Economy doc.
 *
 *   ₹100 → 250 coins ... ₹40,000 → 100,000 coins
 *
 * Every tier is a flat **2.5 coins per rupee**. That invariant is asserted below
 * rather than assumed: nine hand-typed rows are exactly where a transposed digit
 * hides, and a wrong row here sells coins at the wrong price silently.
 *
 * The agency panel (2.75 coins/₹) is deliberately NOT seeded here — those sales
 * do not go through in-app purchase, and putting them in the same catalogue
 * would surface agency pricing inside the app. See the notes at the bottom.
 *
 * Usage:
 *   npx ts-node scripts/seed-coin-packages-inr.ts            # dry run, prints the plan
 *   npx ts-node scripts/seed-coin-packages-inr.ts --apply    # writes
 *
 * Idempotent: upserts on `code`, so re-running corrects rather than duplicates.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Coins credited per rupee on the official panel. */
const COINS_PER_RUPEE = 2.5;

/** Rupee tiers from the pricing doc, in display order. */
const PRICE_TIERS = [100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 40_000];

interface PackageRow {
  code: string;
  name: string;
  coins: number;
  priceAmount: number;
  currency: string;
  country: string;
  platform: string;
  sortOrder: number;
}

function buildRows(): PackageRow[] {
  return PRICE_TIERS.map((price, index) => {
    const coins = price * COINS_PER_RUPEE;
    if (!Number.isInteger(coins)) {
      throw new Error(`Tier ₹${price} yields a fractional coin count (${coins})`);
    }
    return {
      code: `IN_GOLD_${price}`,
      name: `${coins.toLocaleString('en-IN')} Coins`,
      coins,
      priceAmount: price,
      currency: 'INR',
      // Scoped to India: the catalogue filter returns GLOBAL packages plus the
      // caller's own country, so an INR tier must not be GLOBAL or it would be
      // offered to users who cannot be charged in rupees.
      country: 'IN',
      platform: 'ALL',
      sortOrder: index,
    };
  });
}

/** Guards the published economics — the doc's numbers, restated independently. */
const EXPECTED_COINS: Record<number, number> = {
  100: 250,
  200: 500,
  500: 1_250,
  1_000: 2_500,
  2_000: 5_000,
  5_000: 12_500,
  10_000: 25_000,
  20_000: 50_000,
  40_000: 100_000,
};

function assertMatchesPricingDoc(rows: PackageRow[]): void {
  for (const row of rows) {
    const expected = EXPECTED_COINS[row.priceAmount];
    if (expected === undefined) {
      throw new Error(`Tier ₹${row.priceAmount} is not in the pricing doc`);
    }
    if (row.coins !== expected) {
      throw new Error(
        `Tier ₹${row.priceAmount}: computed ${row.coins} coins, doc says ${expected}`,
      );
    }
  }
  if (rows.length !== Object.keys(EXPECTED_COINS).length) {
    throw new Error(`Expected ${Object.keys(EXPECTED_COINS).length} tiers, built ${rows.length}`);
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const rows = buildRows();
  assertMatchesPricingDoc(rows);

  console.log(`\nOfficial INR coin panel — ${rows.length} tiers @ ${COINS_PER_RUPEE} coins/₹\n`);
  for (const row of rows) {
    console.log(
      `  ${row.code.padEnd(16)} ₹${String(row.priceAmount).padStart(6)} → ${String(
        row.coins,
      ).padStart(7)} coins`,
    );
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write.\n');
    return;
  }

  for (const row of rows) {
    await prisma.coinPackage.upsert({
      where: { code: row.code },
      create: { ...row, coins: BigInt(row.coins), isActive: true },
      update: {
        name: row.name,
        coins: BigInt(row.coins),
        priceAmount: row.priceAmount,
        currency: row.currency,
        country: row.country,
        platform: row.platform,
        sortOrder: row.sortOrder,
        isActive: true,
      },
    });
  }

  const total = await prisma.coinPackage.count({ where: { currency: 'INR' } });
  console.log(`\nApplied. ${total} INR package(s) now active.\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
