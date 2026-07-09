-- CreateEnum
CREATE TYPE "GiftType" AS ENUM ('STATIC', 'ANIMATED', 'COMBO', 'LUCKY', 'FESTIVAL', 'PREMIUM');

-- CreateEnum
CREATE TYPE "GiftCategory" AS ENUM ('STANDARD', 'PREMIUM', 'LUXURY', 'EVENT', 'VIP_EXCLUSIVE');

-- CreateEnum
CREATE TYPE "GiftContextType" AS ENUM ('AUDIO_ROOM', 'VIDEO_ROOM', 'LIVE_STREAM', 'PRIVATE_CHAT');

-- CreateEnum
CREATE TYPE "GiftTxnStatus" AS ENUM ('COMPLETED', 'REVERSED');

-- CreateTable
CREATE TABLE "gifts" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "GiftCategory" NOT NULL,
    "type" "GiftType" NOT NULL,
    "coinValue" INTEGER NOT NULL,
    "thumbnailUrl" TEXT,
    "animationUrl" TEXT,
    "soundUrl" TEXT,
    "minVipLevel" INTEGER NOT NULL DEFAULT 0,
    "comboEnabled" BOOLEAN NOT NULL DEFAULT false,
    "comboWindowSeconds" INTEGER NOT NULL DEFAULT 10,
    "luckyMultipliers" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "luckyWinChanceBp" INTEGER NOT NULL DEFAULT 0,
    "festivalTag" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_transactions" (
    "id" UUID NOT NULL,
    "senderId" UUID NOT NULL,
    "receiverId" UUID NOT NULL,
    "giftId" UUID NOT NULL,
    "giftType" "GiftType" NOT NULL,
    "contextType" "GiftContextType" NOT NULL,
    "contextId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "comboTier" INTEGER NOT NULL DEFAULT 1,
    "unitCoinValue" INTEGER NOT NULL,
    "totalCoinValue" BIGINT NOT NULL,
    "creatorEarnings" BIGINT NOT NULL,
    "luckyMultiplier" INTEGER NOT NULL DEFAULT 1,
    "isLuckyWin" BOOLEAN NOT NULL DEFAULT false,
    "senderExp" INTEGER NOT NULL DEFAULT 0,
    "receiverExp" INTEGER NOT NULL DEFAULT 0,
    "status" "GiftTxnStatus" NOT NULL DEFAULT 'COMPLETED',
    "idempotencyKey" TEXT NOT NULL,
    "senderWalletTxnId" UUID,
    "receiverWalletTxnId" UUID,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gifts_enabled_category_idx" ON "gifts"("enabled", "category");

-- CreateIndex
CREATE INDEX "gifts_type_idx" ON "gifts"("type");

-- CreateIndex
CREATE UNIQUE INDEX "gift_transactions_idempotencyKey_key" ON "gift_transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "gift_transactions_contextType_contextId_createdAt_idx" ON "gift_transactions"("contextType", "contextId", "createdAt");

-- CreateIndex
CREATE INDEX "gift_transactions_senderId_createdAt_idx" ON "gift_transactions"("senderId", "createdAt");

-- CreateIndex
CREATE INDEX "gift_transactions_receiverId_createdAt_idx" ON "gift_transactions"("receiverId", "createdAt");

-- CreateIndex
CREATE INDEX "gift_transactions_giftId_idx" ON "gift_transactions"("giftId");
