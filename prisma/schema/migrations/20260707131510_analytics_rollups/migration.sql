-- CreateTable
CREATE TABLE "room_daily_stats" (
    "id" UUID NOT NULL,
    "dateKey" TEXT NOT NULL,
    "roomId" UUID NOT NULL,
    "joins" INTEGER NOT NULL DEFAULT 0,
    "uniqueVisitors" INTEGER NOT NULL DEFAULT 0,
    "peakParticipants" INTEGER NOT NULL DEFAULT 0,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "giftCount" INTEGER NOT NULL DEFAULT 0,
    "giftCoins" BIGINT NOT NULL DEFAULT 0,
    "speakingSeconds" BIGINT NOT NULL DEFAULT 0,
    "engagementScore" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_daily_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_daily_stats" (
    "id" UUID NOT NULL,
    "dateKey" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "giftsReceivedCount" INTEGER NOT NULL DEFAULT 0,
    "giftCoinsReceived" BIGINT NOT NULL DEFAULT 0,
    "creatorEarnings" BIGINT NOT NULL DEFAULT 0,
    "roomsHosted" INTEGER NOT NULL DEFAULT 0,
    "speakingSeconds" BIGINT NOT NULL DEFAULT 0,
    "engagementScore" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_daily_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_daily_stats_roomId_dateKey_idx" ON "room_daily_stats"("roomId", "dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "room_daily_stats_dateKey_roomId_key" ON "room_daily_stats"("dateKey", "roomId");

-- CreateIndex
CREATE INDEX "creator_daily_stats_userId_dateKey_idx" ON "creator_daily_stats"("userId", "dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "creator_daily_stats_dateKey_userId_key" ON "creator_daily_stats"("dateKey", "userId");
