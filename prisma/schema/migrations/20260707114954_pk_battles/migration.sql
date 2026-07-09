-- CreateEnum
CREATE TYPE "PkMode" AS ENUM ('ONE_VS_ONE', 'TEAM');

-- CreateEnum
CREATE TYPE "PkSide" AS ENUM ('RED', 'BLUE');

-- CreateEnum
CREATE TYPE "PkStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PkResult" AS ENUM ('RED', 'BLUE', 'DRAW');

-- CreateTable
CREATE TABLE "pk_battles" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "mode" "PkMode" NOT NULL,
    "status" "PkStatus" NOT NULL DEFAULT 'ACTIVE',
    "durationSeconds" INTEGER NOT NULL,
    "startedBy" UUID NOT NULL,
    "redScore" BIGINT NOT NULL DEFAULT 0,
    "blueScore" BIGINT NOT NULL DEFAULT 0,
    "result" "PkResult",
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "pk_battles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pk_participants" (
    "id" UUID NOT NULL,
    "battleId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "side" "PkSide" NOT NULL,
    "score" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pk_contributions" (
    "id" UUID NOT NULL,
    "battleId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "side" "PkSide" NOT NULL,
    "contributorId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "giftTxnId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pk_rewards" (
    "id" UUID NOT NULL,
    "battleId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "side" "PkSide" NOT NULL,
    "cosmeticId" UUID,
    "backpackItemId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pk_battles_roomId_status_idx" ON "pk_battles"("roomId", "status");

-- CreateIndex
CREATE INDEX "pk_battles_status_endsAt_idx" ON "pk_battles"("status", "endsAt");

-- CreateIndex
CREATE INDEX "pk_participants_battleId_idx" ON "pk_participants"("battleId");

-- CreateIndex
CREATE UNIQUE INDEX "pk_participants_battleId_userId_key" ON "pk_participants"("battleId", "userId");

-- CreateIndex
CREATE INDEX "pk_contributions_battleId_idx" ON "pk_contributions"("battleId");

-- CreateIndex
CREATE INDEX "pk_contributions_participantId_idx" ON "pk_contributions"("participantId");

-- CreateIndex
CREATE INDEX "pk_rewards_battleId_idx" ON "pk_rewards"("battleId");

-- CreateIndex
CREATE INDEX "pk_rewards_userId_idx" ON "pk_rewards"("userId");
