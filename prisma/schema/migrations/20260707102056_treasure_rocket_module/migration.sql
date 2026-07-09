-- CreateEnum
CREATE TYPE "TreasureSessionStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TreasureBoxStatus" AS ENUM ('PENDING', 'ACTIVE', 'OPENED');

-- CreateEnum
CREATE TYPE "RocketStatus" AS ENUM ('ACTIVE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "TreasureRewardKind" AS ENUM ('COINS', 'BACKPACK_ITEM');

-- CreateTable
CREATE TABLE "treasure_box_configs" (
    "id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "threshold" BIGINT NOT NULL,
    "rewards" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "treasure_box_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasure_sessions" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "contextType" TEXT NOT NULL DEFAULT 'AUDIO_ROOM',
    "startedBy" UUID NOT NULL,
    "status" "TreasureSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentLevel" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "treasure_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasure_boxes" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "threshold" BIGINT NOT NULL,
    "progress" BIGINT NOT NULL DEFAULT 0,
    "status" "TreasureBoxStatus" NOT NULL DEFAULT 'PENDING',
    "topGifters" JSONB,
    "openedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treasure_boxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasure_contributions" (
    "id" UUID NOT NULL,
    "boxId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "giftTxnId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treasure_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasure_rewards" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "boxId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "userId" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "kind" "TreasureRewardKind" NOT NULL,
    "coins" BIGINT,
    "itemType" TEXT,
    "itemName" TEXT,
    "walletTxnId" UUID,
    "backpackItemId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treasure_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rocket_configs" (
    "id" UUID NOT NULL,
    "triggerGiftId" UUID NOT NULL,
    "durationSeconds" INTEGER NOT NULL DEFAULT 60,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "rewardPool" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rocket_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rocket_events" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "contextType" TEXT NOT NULL DEFAULT 'AUDIO_ROOM',
    "triggerGiftId" UUID NOT NULL,
    "triggeredBy" UUID NOT NULL,
    "status" "RocketStatus" NOT NULL DEFAULT 'ACTIVE',
    "totalContribution" BIGINT NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "rocket_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rocket_contributions" (
    "id" UUID NOT NULL,
    "rocketId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "giftTxnId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rocket_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rocket_rewards" (
    "id" UUID NOT NULL,
    "rocketId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "kind" "TreasureRewardKind" NOT NULL,
    "coins" BIGINT,
    "itemType" TEXT,
    "itemName" TEXT,
    "walletTxnId" UUID,
    "backpackItemId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rocket_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "treasure_box_configs_level_key" ON "treasure_box_configs"("level");

-- CreateIndex
CREATE INDEX "treasure_sessions_roomId_status_idx" ON "treasure_sessions"("roomId", "status");

-- CreateIndex
CREATE INDEX "treasure_boxes_roomId_idx" ON "treasure_boxes"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "treasure_boxes_sessionId_level_key" ON "treasure_boxes"("sessionId", "level");

-- CreateIndex
CREATE INDEX "treasure_contributions_boxId_idx" ON "treasure_contributions"("boxId");

-- CreateIndex
CREATE INDEX "treasure_contributions_boxId_userId_idx" ON "treasure_contributions"("boxId", "userId");

-- CreateIndex
CREATE INDEX "treasure_contributions_roomId_createdAt_idx" ON "treasure_contributions"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "treasure_rewards_sessionId_idx" ON "treasure_rewards"("sessionId");

-- CreateIndex
CREATE INDEX "treasure_rewards_userId_idx" ON "treasure_rewards"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "rocket_configs_triggerGiftId_key" ON "rocket_configs"("triggerGiftId");

-- CreateIndex
CREATE INDEX "rocket_events_roomId_status_idx" ON "rocket_events"("roomId", "status");

-- CreateIndex
CREATE INDEX "rocket_events_status_endsAt_idx" ON "rocket_events"("status", "endsAt");

-- CreateIndex
CREATE INDEX "rocket_contributions_rocketId_idx" ON "rocket_contributions"("rocketId");

-- CreateIndex
CREATE INDEX "rocket_contributions_rocketId_userId_idx" ON "rocket_contributions"("rocketId", "userId");

-- CreateIndex
CREATE INDEX "rocket_rewards_rocketId_idx" ON "rocket_rewards"("rocketId");

-- CreateIndex
CREATE INDEX "rocket_rewards_userId_idx" ON "rocket_rewards"("userId");
