-- Casino module (Greedy Food + Lucky Fruit): house-banked casino games.
-- Adds the `casino_rounds` / `casino_bets` tables plus the CASINO_* wallet
-- txn reasons and GREEDY_FOOD/LUCKY_FRUIT GameCode values used to record
-- and settle bets. Currency is GOLD only; payouts are server-funded
-- (stake x multiplier), not pot redistributions — see
-- docs/superpowers/specs/2026-07-16-greedy-food-lucky-fruit-casino-design.md
-- §5.5-5.6. Purely additive: no existing tables/columns are touched.
--
-- AMENDED (still unapplied) to add `casino_bets.clientBetId` + its
-- `(roundId, userId, clientBetId)` unique index: the row-level idempotency
-- anchor for faithful bet stacking (one row per tap, keyed by a per-tap
-- client id) instead of a per-item key that both broke stacking and could
-- double-pay one debit.
--
-- Generated offline via `prisma migrate diff --from-schema-datamodel
-- <pre-change schema snapshot> --to-schema-datamodel prisma/schema --script`
-- (no database connection was made; not applied).

-- CreateEnum
CREATE TYPE "CasinoGame" AS ENUM ('GREEDY_FOOD', 'LUCKY_FRUIT');

-- CreateEnum
CREATE TYPE "CasinoRoundStatus" AS ENUM ('BETTING', 'SPINNING', 'SETTLED', 'ABORTED');

-- CreateEnum
CREATE TYPE "CasinoBetStatus" AS ENUM ('PLACED', 'WON', 'LOST', 'REFUNDED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "GameCode" ADD VALUE 'GREEDY_FOOD';
ALTER TYPE "GameCode" ADD VALUE 'LUCKY_FRUIT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WalletTxnReason" ADD VALUE 'CASINO_BET';
ALTER TYPE "WalletTxnReason" ADD VALUE 'CASINO_WIN';
ALTER TYPE "WalletTxnReason" ADD VALUE 'CASINO_REFUND';

-- CreateTable
CREATE TABLE "casino_rounds" (
    "id" UUID NOT NULL,
    "game" "CasinoGame" NOT NULL,
    "status" "CasinoRoundStatus" NOT NULL DEFAULT 'BETTING',
    "winningOutcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "casino_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "casino_bets" (
    "id" UUID NOT NULL,
    "roundId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "game" "CasinoGame" NOT NULL,
    "betItem" TEXT NOT NULL,
    "betAmount" BIGINT NOT NULL,
    "clientBetId" TEXT NOT NULL,
    "status" "CasinoBetStatus" NOT NULL DEFAULT 'PLACED',
    "payoutAmount" BIGINT NOT NULL DEFAULT 0,
    "betTxnId" TEXT,
    "winTxnId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "casino_bets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "casino_rounds_game_status_idx" ON "casino_rounds"("game", "status");

-- CreateIndex
CREATE UNIQUE INDEX "casino_bets_roundId_userId_clientBetId_key" ON "casino_bets"("roundId", "userId", "clientBetId");

-- CreateIndex
CREATE INDEX "casino_bets_userId_game_status_idx" ON "casino_bets"("userId", "game", "status");

-- CreateIndex
CREATE INDEX "casino_bets_roundId_idx" ON "casino_bets"("roundId");

-- AddForeignKey
ALTER TABLE "casino_bets" ADD CONSTRAINT "casino_bets_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "casino_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
