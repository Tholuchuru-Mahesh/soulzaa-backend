-- CreateEnum
CREATE TYPE "LuckyPacketDistribution" AS ENUM ('RANDOM', 'FIXED');

-- CreateEnum
CREATE TYPE "LuckyPacketStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "RoomPollStatus" AS ENUM ('ACTIVE', 'ENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CoinFace" AS ENUM ('HEADS', 'TAILS');

-- CreateEnum
CREATE TYPE "RandomPickPool" AS ENUM ('ALL', 'SPEAKERS', 'AUDIENCE', 'NUMBER');

-- CreateEnum
CREATE TYPE "SpinWheelStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RoomCountdownStatus" AS ENUM ('RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WalletTxnReason" ADD VALUE 'LUCKY_PACKET_CREATE';
ALTER TYPE "WalletTxnReason" ADD VALUE 'LUCKY_PACKET_CLAIM';
ALTER TYPE "WalletTxnReason" ADD VALUE 'LUCKY_PACKET_REFUND';
ALTER TYPE "WalletTxnReason" ADD VALUE 'SPIN_WHEEL_REWARD';

-- CreateTable
CREATE TABLE "lucky_packets" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "currency" "WalletCurrency" NOT NULL DEFAULT 'GOLD',
    "totalCoins" BIGINT NOT NULL,
    "winnerCount" INTEGER NOT NULL,
    "distribution" "LuckyPacketDistribution" NOT NULL,
    "message" TEXT,
    "status" "LuckyPacketStatus" NOT NULL DEFAULT 'ACTIVE',
    "remainingCoins" BIGINT NOT NULL,
    "remainingSlots" INTEGER NOT NULL,
    "debitTxnId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lucky_packets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lucky_packet_claims" (
    "id" UUID NOT NULL,
    "packetId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "walletTxnId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lucky_packet_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_polls" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "status" "RoomPollStatus" NOT NULL DEFAULT 'ACTIVE',
    "allowMultiple" BOOLEAN NOT NULL DEFAULT false,
    "endsAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_polls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_poll_options" (
    "id" UUID NOT NULL,
    "pollId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "voteCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "room_poll_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_poll_votes" (
    "id" UUID NOT NULL,
    "pollId" UUID NOT NULL,
    "optionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_poll_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dice_rolls" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "diceCount" INTEGER NOT NULL DEFAULT 1,
    "values" INTEGER[],
    "total" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dice_rolls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_flips" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "result" "CoinFace" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coin_flips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "random_picks" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "pool" "RandomPickPool" NOT NULL,
    "rangeMin" INTEGER,
    "rangeMax" INTEGER,
    "pickedUserId" UUID,
    "pickedNumber" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "random_picks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spin_wheels" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" "SpinWheelStatus" NOT NULL DEFAULT 'ACTIVE',
    "segments" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spin_wheels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spin_results" (
    "id" UUID NOT NULL,
    "wheelId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "segmentLabel" TEXT NOT NULL,
    "rewardCoins" BIGINT,
    "walletTxnId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spin_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_countdowns" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "label" TEXT,
    "durationSeconds" INTEGER NOT NULL,
    "remainingSeconds" INTEGER NOT NULL,
    "status" "RoomCountdownStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "room_countdowns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lucky_packets_roomId_status_idx" ON "lucky_packets"("roomId", "status");

-- CreateIndex
CREATE INDEX "lucky_packets_status_expiresAt_idx" ON "lucky_packets"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "lucky_packet_claims_packetId_idx" ON "lucky_packet_claims"("packetId");

-- CreateIndex
CREATE INDEX "lucky_packet_claims_userId_createdAt_idx" ON "lucky_packet_claims"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "lucky_packet_claims_packetId_userId_key" ON "lucky_packet_claims"("packetId", "userId");

-- CreateIndex
CREATE INDEX "room_polls_roomId_status_idx" ON "room_polls"("roomId", "status");

-- CreateIndex
CREATE INDEX "room_poll_options_pollId_idx" ON "room_poll_options"("pollId");

-- CreateIndex
CREATE INDEX "room_poll_votes_pollId_idx" ON "room_poll_votes"("pollId");

-- CreateIndex
CREATE UNIQUE INDEX "room_poll_votes_pollId_userId_key" ON "room_poll_votes"("pollId", "userId");

-- CreateIndex
CREATE INDEX "dice_rolls_roomId_createdAt_idx" ON "dice_rolls"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "coin_flips_roomId_createdAt_idx" ON "coin_flips"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "random_picks_roomId_createdAt_idx" ON "random_picks"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "spin_wheels_roomId_status_idx" ON "spin_wheels"("roomId", "status");

-- CreateIndex
CREATE INDEX "spin_results_wheelId_idx" ON "spin_results"("wheelId");

-- CreateIndex
CREATE INDEX "spin_results_roomId_createdAt_idx" ON "spin_results"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "room_countdowns_roomId_status_idx" ON "room_countdowns"("roomId", "status");

-- CreateIndex
CREATE INDEX "room_countdowns_status_endsAt_idx" ON "room_countdowns"("status", "endsAt");

-- AddForeignKey
ALTER TABLE "lucky_packet_claims" ADD CONSTRAINT "lucky_packet_claims_packetId_fkey" FOREIGN KEY ("packetId") REFERENCES "lucky_packets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_poll_options" ADD CONSTRAINT "room_poll_options_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "room_polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_poll_votes" ADD CONSTRAINT "room_poll_votes_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "room_poll_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spin_results" ADD CONSTRAINT "spin_results_wheelId_fkey" FOREIGN KEY ("wheelId") REFERENCES "spin_wheels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
