-- Pre-existing schema drift.
--
-- These changes were already present in the .prisma schema files but had never
-- been captured in a migration — the schema and the database had diverged. They
-- are split out here, away from the admin-identity work that happened to be the
-- next migration generated, so that the destructive change below is reviewed on
-- its own merits rather than riding along inside an unrelated feature.
--
-- ⚠️  DESTRUCTIVE: drops room_members."tempSpeakAllowed".
--     At the time of writing, production held 22 rows with a non-null value in
--     that column. No application code references it — the feature was removed
--     and the column deleted from the schema, leaving the data orphaned. Export
--     those rows before deploying if they have not already been backed up:
--
--       copy (select id, "roomId", "userId", "tempSpeakAllowed"
--             from room_members where "tempSpeakAllowed" is not null)
--       to stdout with csv header;

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ROLE_REQUEST_UPDATE';
ALTER TYPE "NotificationType" ADD VALUE 'ROLE_GRANTED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WalletTxnReason" ADD VALUE 'ATTENDANCE_REWARD';
ALTER TYPE "WalletTxnReason" ADD VALUE 'PK_BATTLE_RECEIVER_BONUS';

-- AlterTable
ALTER TABLE "game_lobbies" ADD COLUMN     "carromMode" TEXT DEFAULT 'classic',
ADD COLUMN     "teamCoinAssignment" TEXT DEFAULT 'team_a_white';

-- AlterTable
ALTER TABLE "game_sessions" ADD COLUMN     "carromMode" TEXT DEFAULT 'classic',
ADD COLUMN     "teamCoinAssignment" TEXT DEFAULT 'team_a_white';

-- AlterTable
ALTER TABLE "role_request_actions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "role_requests" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
-- ⚠️  Destructive. See the header note above.
ALTER TABLE "room_members" DROP COLUMN "tempSpeakAllowed";

-- AlterTable
ALTER TABLE "seat_requests" ALTER COLUMN "type" SET DEFAULT 'REQUEST_TO_SEAT';

-- CreateTable
CREATE TABLE "attendance_ladder_rungs" (
    "id" UUID NOT NULL,
    "day" INTEGER NOT NULL,
    "coins" INTEGER NOT NULL,
    "currency" "WalletCurrency" NOT NULL DEFAULT 'FREE',
    "expAmount" INTEGER,
    "cosmeticId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_ladder_rungs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_attendance" (
    "userId" UUID NOT NULL,
    "currentDay" INTEGER NOT NULL DEFAULT 0,
    "cycleCount" INTEGER NOT NULL DEFAULT 0,
    "lastClaimDayKey" TEXT,
    "lastClaimAt" TIMESTAMP(3),
    "lastClaimTimezone" TEXT,
    "totalClaims" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_attendance_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "attendance_claims" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "day" INTEGER NOT NULL,
    "cycle" INTEGER NOT NULL,
    "dayKey" TEXT NOT NULL,
    "coins" INTEGER NOT NULL,
    "currency" "WalletCurrency" NOT NULL,
    "expAmount" INTEGER,
    "cosmeticId" UUID,
    "timezone" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_ladder_rungs_day_key" ON "attendance_ladder_rungs"("day");

-- CreateIndex
CREATE INDEX "attendance_claims_userId_claimedAt_idx" ON "attendance_claims"("userId", "claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_claims_userId_dayKey_key" ON "attendance_claims"("userId", "dayKey");
