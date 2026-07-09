-- CreateEnum
CREATE TYPE "ExpSource" AS ENUM ('DAILY_LOGIN', 'GIFT_SENT', 'GIFT_RECEIVED', 'ROOM_JOIN', 'LIVE_STREAM', 'GAME', 'EVENT', 'TASK', 'ADMIN');

-- CreateTable
CREATE TABLE "user_exp" (
    "userId" UUID NOT NULL,
    "totalExp" BIGINT NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_exp_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "exp_logs" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" "ExpSource" NOT NULL,
    "referenceType" TEXT,
    "referenceId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "totalAfter" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exp_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "level_configs" (
    "level" INTEGER NOT NULL,
    "minExp" BIGINT NOT NULL,
    "title" TEXT,
    "rewards" JSONB NOT NULL DEFAULT '[]',
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "level_configs_pkey" PRIMARY KEY ("level")
);

-- CreateTable
CREATE TABLE "room_exp" (
    "roomId" UUID NOT NULL,
    "totalExp" BIGINT NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_exp_pkey" PRIMARY KEY ("roomId")
);

-- CreateTable
CREATE TABLE "room_exp_logs" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" "ExpSource" NOT NULL,
    "referenceId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "totalAfter" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_exp_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_level_configs" (
    "level" INTEGER NOT NULL,
    "minExp" BIGINT NOT NULL,
    "title" TEXT,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_level_configs_pkey" PRIMARY KEY ("level")
);

-- CreateIndex
CREATE UNIQUE INDEX "exp_logs_idempotencyKey_key" ON "exp_logs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "exp_logs_userId_createdAt_idx" ON "exp_logs"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "room_exp_logs_idempotencyKey_key" ON "room_exp_logs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "room_exp_logs_roomId_createdAt_idx" ON "room_exp_logs"("roomId", "createdAt");
