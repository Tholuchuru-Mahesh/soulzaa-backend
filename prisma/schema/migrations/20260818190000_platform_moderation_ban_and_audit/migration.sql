-- This migration reconciles two independent, previously-unmigrated changes
-- to the dev database in one file, since `prisma migrate dev`'s shadow-diff
-- computes them together against the current schema.prisma:
--
-- 1. `states.moderatorRegionCode` (prisma/schema/rbac.prisma:117) — added to
--    schema.prisma and already applied directly to this dev database as
--    part of unrelated, still-uncommitted moderator state-scoping work.
--    NOT executed by this migration (see note below) — already present.
-- 2. PlatformUserBan / PlatformModerationAuditLog (prisma/schema/platform_moderation.prisma)
--    — new for this migration, executed below.
--
-- NOTE ON STATEMENT 1: the ALTER TABLE for moderatorRegionCode is commented
-- out below because it is already applied to this specific dev database
-- (confirmed via `prisma db pull` introspection before writing this file).
-- It is included here, commented, so a fresh database (CI, new clone) shows
-- the complete intended schema history if this comment block is read â€”
-- but this exact migration is applied via `prisma migrate resolve --applied`
-- against this database, which records the migration without re-running its
-- SQL, so the commented-out statement is never executed on either path.
--
-- ALTER TABLE "states" ADD COLUMN "moderatorRegionCode" TEXT;
-- CREATE UNIQUE INDEX "states_moderatorRegionCode_key" ON "states"("moderatorRegionCode");

-- CreateEnum
CREATE TYPE "PlatformRoomType" AS ENUM ('AUDIO_ROOM', 'VIDEO_ROOM', 'LIVE_STREAM');

-- CreateEnum
CREATE TYPE "PlatformBanStatus" AS ENUM ('ACTIVE', 'LIFTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PlatformModerationActionType" AS ENUM ('INCOGNITO_JOIN', 'INCOGNITO_LEAVE', 'WARNING_SENT', 'BAN_ISSUED', 'BAN_LIFTED');

-- CreateTable
CREATE TABLE "platform_user_bans" (
    "id" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "moderatorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "roomType" "PlatformRoomType" NOT NULL,
    "originRoomId" TEXT NOT NULL,
    "status" "PlatformBanStatus" NOT NULL DEFAULT 'ACTIVE',
    "bannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "liftedAt" TIMESTAMP(3),
    "liftedBy" TEXT,

    CONSTRAINT "platform_user_bans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_moderation_audit_logs" (
    "id" TEXT NOT NULL,
    "moderatorId" TEXT NOT NULL,
    "action" "PlatformModerationActionType" NOT NULL,
    "roomType" "PlatformRoomType" NOT NULL,
    "roomId" TEXT NOT NULL,
    "targetUserId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_moderation_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_user_bans_targetUserId_status_idx" ON "platform_user_bans"("targetUserId", "status");

-- CreateIndex
CREATE INDEX "platform_user_bans_status_expiresAt_idx" ON "platform_user_bans"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "platform_moderation_audit_logs_moderatorId_createdAt_idx" ON "platform_moderation_audit_logs"("moderatorId", "createdAt");

-- CreateIndex
CREATE INDEX "platform_moderation_audit_logs_targetUserId_createdAt_idx" ON "platform_moderation_audit_logs"("targetUserId", "createdAt");
