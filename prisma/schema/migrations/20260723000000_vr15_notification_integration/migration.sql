-- prisma/migrations/vr15_notification_integration/migration.sql
-- VR-15 notification integration. Fully additive: enum ADD VALUE (ordered first,
-- outside the column txn), defaulted preference columns, one new table. No
-- backfill, no downtime. Authored-only (mirrors vr11/vr12) if shadow-replay is
-- blocked in this environment.

-- 1) NotificationType enum additions. ADD VALUE cannot run in the same tx as
--    statements that use the value, so these come first, each idempotent.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ROOM_STARTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ROOM_CLOSED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ROOM_LOCKED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ROOM_UNLOCKED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SEAT_INVITE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SEAT_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SEAT_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VIEWER_PROMOTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VIEWER_DEMOTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TREASURE_UNLOCKED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TREASURE_REWARD';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PK_ACCEPTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PK_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PK_STARTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PK_ENDED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PK_WINNER';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MENTION';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SYSTEM';

-- 2) Preference columns (additive, defaulted true).
ALTER TABLE "notification_preferences"
  ADD COLUMN IF NOT EXISTS "roomEvents" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "seatEvents" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "treasureEvents" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "pkEvents" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "announcementEvents" BOOLEAN NOT NULL DEFAULT true;

-- 3) Per-room mute table.
CREATE TABLE IF NOT EXISTS "video_room_notification_mutes" (
  "id"        UUID NOT NULL,
  "userId"    UUID NOT NULL,
  "roomId"    UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "video_room_notification_mutes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "video_room_notification_mutes_userId_roomId_key"
  ON "video_room_notification_mutes" ("userId", "roomId");
CREATE INDEX IF NOT EXISTS "video_room_notification_mutes_userId_idx"
  ON "video_room_notification_mutes" ("userId");
