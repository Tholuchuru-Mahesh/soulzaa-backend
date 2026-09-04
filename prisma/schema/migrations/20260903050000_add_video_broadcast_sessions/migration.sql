-- The `VideoBroadcastSession` model (prisma/schema/video_rooms_broadcast.prisma)
-- was added to the Prisma schema without ever generating its migration, so the
-- `video_broadcast_sessions` table has never existed in this database — every
-- call that starts or ends a broadcast (activate/create-reactivate/close) has
-- been failing with "table ... does not exist" against a live DB. This
-- migration creates exactly that table, matching the schema file bit for bit.

CREATE TYPE "VideoBroadcastSessionStatus" AS ENUM ('LIVE', 'ENDED', 'TERMINATED');

CREATE TABLE "video_broadcast_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "roomId" UUID NOT NULL,
  "hostId" UUID NOT NULL,
  "title" TEXT,
  "topic" TEXT,
  "category" TEXT,
  "imageKey" TEXT,
  "status" "VideoBroadcastSessionStatus" NOT NULL DEFAULT 'LIVE',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),
  "endReason" TEXT,
  "durationSeconds" INTEGER NOT NULL DEFAULT 0,
  "totalViewers" INTEGER NOT NULL DEFAULT 0,
  "peakViewers" INTEGER NOT NULL DEFAULT 0,
  "uniqueViewers" INTEGER NOT NULL DEFAULT 0,
  "totalGifts" INTEGER NOT NULL DEFAULT 0,
  "totalGiftCoins" BIGINT NOT NULL DEFAULT 0,
  "creatorEarnings" BIGINT NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "video_broadcast_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "video_broadcast_sessions_roomId_status_idx" ON "video_broadcast_sessions"("roomId", "status");
CREATE INDEX "video_broadcast_sessions_hostId_createdAt_idx" ON "video_broadcast_sessions"("hostId", "createdAt");
CREATE INDEX "video_broadcast_sessions_roomId_startedAt_idx" ON "video_broadcast_sessions"("roomId", "startedAt");
CREATE INDEX "video_broadcast_sessions_status_idx" ON "video_broadcast_sessions"("status");

ALTER TABLE "video_broadcast_sessions" ADD CONSTRAINT "video_broadcast_sessions_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "video_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
