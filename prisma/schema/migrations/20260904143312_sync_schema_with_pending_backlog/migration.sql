/*
  Warnings:

  - You are about to drop the column `displayOrder` on the `wealth_levels` table. All the data in the column will be lost.
  - You are about to drop the `wealth_level_rewards` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `wealth_reward_claims` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "VideoRoomEntryAccessStatus" AS ENUM ('GRANTED', 'REVOKED', 'REFUNDED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'MODERATOR_TASK_COMPLETED';

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'ENTRY_FEE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WalletTxnReason" ADD VALUE 'VIDEO_ROOM_ENTRY_FEE';
ALTER TYPE "WalletTxnReason" ADD VALUE 'VIDEO_ROOM_ENTRY_REFUND';
ALTER TYPE "WalletTxnReason" ADD VALUE 'VIDEO_ROOM_ENTRY_EARNING';

-- AlterEnum
ALTER TYPE "WealthBenefitType" ADD VALUE 'GOLD_COINS';

-- DropForeignKey
ALTER TABLE "wealth_level_rewards" DROP CONSTRAINT "wealth_level_rewards_level_fkey";

-- DropForeignKey
ALTER TABLE "wealth_reward_claims" DROP CONSTRAINT "wealth_reward_claims_rewardId_fkey";

-- AlterTable
ALTER TABLE "moderator_task_assignments" ADD COLUMN     "banReason" TEXT,
ADD COLUMN     "bannedUserIds" UUID[],
ADD COLUMN     "currentProgress" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN     "remarks" TEXT,
ADD COLUMN     "startDate" TIMESTAMP(3),
ADD COLUMN     "targetCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "targetUserId" UUID,
ADD COLUMN     "targetUserIds" UUID[],
ADD COLUMN     "taskType" TEXT NOT NULL DEFAULT 'GENERAL';

-- AlterTable
ALTER TABLE "platform_moderation_audit_logs" ALTER COLUMN "roomId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "platform_user_bans" ALTER COLUMN "originRoomId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "user_devices" ADD COLUMN     "voipPushToken" TEXT;

-- AlterTable
ALTER TABLE "video_broadcast_sessions" ADD COLUMN     "entryCreatorEarnings" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "entryFee" BIGINT,
ADD COLUMN     "paidEntryEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totalEntryRevenue" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "totalPaidEntrants" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "video_rooms" ADD COLUMN     "defaultEntryFee" BIGINT,
ADD COLUMN     "paidEntryEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "wealth_level_benefits" ADD COLUMN     "categoryId" UUID,
ADD COLUMN     "coinAmount" INTEGER,
ADD COLUMN     "cosmeticId" UUID,
ADD COLUMN     "durationDays" INTEGER;

-- AlterTable
ALTER TABLE "wealth_levels" DROP COLUMN "displayOrder",
ADD COLUMN     "backgroundUrl" TEXT;

-- DropTable
DROP TABLE "wealth_level_rewards";

-- DropTable
DROP TABLE "wealth_reward_claims";

-- DropEnum
DROP TYPE "WealthClaimStatus";

-- DropEnum
DROP TYPE "WealthRewardFrequency";

-- DropEnum
DROP TYPE "WealthRewardGrantType";

-- DropEnum
DROP TYPE "WealthRewardType";

-- CreateTable
CREATE TABLE "room_weekly_contributions" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "weekKey" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "weekEnd" TIMESTAMP(3) NOT NULL,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_weekly_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_weekly_contributions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "weekKey" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "weekEnd" TIMESTAMP(3) NOT NULL,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_weekly_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_entry_accesses" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "transactionId" UUID,
    "amountPaid" BIGINT NOT NULL DEFAULT 0,
    "creatorEarnings" BIGINT NOT NULL DEFAULT 0,
    "status" "VideoRoomEntryAccessStatus" NOT NULL DEFAULT 'GRANTED',
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_room_entry_accesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wealth_benefit_categories" (
    "id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "iconUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wealth_benefit_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wealth_benefit_claims" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "benefitId" UUID NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wealth_benefit_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_weekly_contributions_weekKey_idx" ON "room_weekly_contributions"("weekKey");

-- CreateIndex
CREATE INDEX "room_weekly_contributions_weekStart_idx" ON "room_weekly_contributions"("weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "room_weekly_contributions_roomId_weekKey_key" ON "room_weekly_contributions"("roomId", "weekKey");

-- CreateIndex
CREATE INDEX "user_weekly_contributions_weekKey_idx" ON "user_weekly_contributions"("weekKey");

-- CreateIndex
CREATE INDEX "user_weekly_contributions_weekStart_idx" ON "user_weekly_contributions"("weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "user_weekly_contributions_userId_weekKey_key" ON "user_weekly_contributions"("userId", "weekKey");

-- CreateIndex
CREATE INDEX "video_room_entry_accesses_roomId_sessionId_idx" ON "video_room_entry_accesses"("roomId", "sessionId");

-- CreateIndex
CREATE INDEX "video_room_entry_accesses_userId_roomId_idx" ON "video_room_entry_accesses"("userId", "roomId");

-- CreateIndex
CREATE INDEX "video_room_entry_accesses_status_idx" ON "video_room_entry_accesses"("status");

-- CreateIndex
CREATE UNIQUE INDEX "video_room_entry_accesses_userId_sessionId_key" ON "video_room_entry_accesses"("userId", "sessionId");

-- CreateIndex
CREATE INDEX "wealth_benefit_categories_level_idx" ON "wealth_benefit_categories"("level");

-- CreateIndex
CREATE INDEX "wealth_benefit_claims_userId_idx" ON "wealth_benefit_claims"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "wealth_benefit_claims_userId_benefitId_key" ON "wealth_benefit_claims"("userId", "benefitId");

-- CreateIndex
CREATE INDEX "wealth_level_benefits_categoryId_idx" ON "wealth_level_benefits"("categoryId");

-- AddForeignKey
ALTER TABLE "video_room_entry_accesses" ADD CONSTRAINT "video_room_entry_accesses_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "video_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_room_entry_accesses" ADD CONSTRAINT "video_room_entry_accesses_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "video_broadcast_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wealth_benefit_categories" ADD CONSTRAINT "wealth_benefit_categories_level_fkey" FOREIGN KEY ("level") REFERENCES "wealth_levels"("level") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wealth_level_benefits" ADD CONSTRAINT "wealth_level_benefits_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "wealth_benefit_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wealth_benefit_claims" ADD CONSTRAINT "wealth_benefit_claims_benefitId_fkey" FOREIGN KEY ("benefitId") REFERENCES "wealth_level_benefits"("id") ON DELETE CASCADE ON UPDATE CASCADE;
