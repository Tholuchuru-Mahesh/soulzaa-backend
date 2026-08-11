-- CreateEnum
CREATE TYPE "RoomLiveSessionStatus" AS ENUM ('LIVE', 'ENDED');

-- CreateTable
CREATE TABLE "room_live_sessions" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "status" "RoomLiveSessionStatus" NOT NULL DEFAULT 'LIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_live_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_live_sessions_ownerId_startedAt_idx" ON "room_live_sessions"("ownerId", "startedAt");

-- CreateIndex
CREATE INDEX "room_live_sessions_roomId_startedAt_idx" ON "room_live_sessions"("roomId", "startedAt");

-- CreateIndex
CREATE INDEX "room_live_sessions_status_idx" ON "room_live_sessions"("status");
