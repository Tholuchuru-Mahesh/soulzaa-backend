-- CreateTable
CREATE TABLE "room_activities" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "peakParticipants" INTEGER NOT NULL DEFAULT 0,
    "totalJoined" INTEGER NOT NULL DEFAULT 0,
    "totalGifts" INTEGER NOT NULL DEFAULT 0,
    "totalGiftCoins" BIGINT NOT NULL DEFAULT 0,
    "totalSpeakingMinutes" INTEGER NOT NULL DEFAULT 0,
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_visitors" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_visitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "speaker_sessions" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "joinedSeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftSeatAt" TIMESTAMP(3),
    "speakingSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "speaker_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_reports" (
    "id" UUID NOT NULL,
    "dateKey" TEXT NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "giftCoins" BIGINT NOT NULL DEFAULT 0,
    "creatorCoins" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "revenue_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "room_activities_roomId_key" ON "room_activities"("roomId");

-- CreateIndex
CREATE INDEX "room_activities_roomId_idx" ON "room_activities"("roomId");

-- CreateIndex
CREATE INDEX "room_visitors_roomId_userId_idx" ON "room_visitors"("roomId", "userId");

-- CreateIndex
CREATE INDEX "speaker_sessions_roomId_userId_idx" ON "speaker_sessions"("roomId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_reports_dateKey_roomId_userId_key" ON "revenue_reports"("dateKey", "roomId", "userId");
