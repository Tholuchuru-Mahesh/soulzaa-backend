"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
const COINS_PER_RUPEE = 2.5;
const PRICE_TIERS = [100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 40_000];
function buildRows() {
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
            country: 'IN',
            platform: 'ALL',
            sortOrder: index,
        };
    });
}
const EXPECTED_COINS = {
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
function assertMatchesPricingDoc(rows) {
    for (const row of rows) {
        const expected = EXPECTED_COINS[row.priceAmount];
        if (expected === undefined) {
            throw new Error(`Tier ₹${row.priceAmount} is not in the pricing doc`);
        }
        if (row.coins !== expected) {
            throw new Error(`Tier ₹${row.priceAmount}: computed ${row.coins} coins, doc says ${expected}`);
        }
    }
    if (rows.length !== Object.keys(EXPECTED_COINS).length) {
        throw new Error(`Expected ${Object.keys(EXPECTED_COINS).length} tiers, built ${rows.length}`);
    }
}
async function main() {
    const apply = process.argv.includes('--apply');
    const rows = buildRows();
    assertMatchesPricingDoc(rows);
    console.log(`\nOfficial INR coin panel — ${rows.length} tiers @ ${COINS_PER_RUPEE} coins/₹\n`);
    for (const row of rows) {
        console.log(`  ${row.code.padEnd(16)} ₹${String(row.priceAmount).padStart(6)} → ${String(row.coins).padStart(7)} coins`);
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
//# sourceMappingURL=seed-coin-packages-inr.js.map