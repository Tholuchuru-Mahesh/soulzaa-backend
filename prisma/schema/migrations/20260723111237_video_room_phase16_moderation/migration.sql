-- Video Rooms — Phase 16 (VR-16): Moderation Engine, data-layer foundation.
--
-- Additive only — no existing table/enum values are dropped, reordered, or
-- renamed. Adds two new tables (video_room_reports, video_room_warnings) and
-- two new enums (VideoRoomReportReason, VideoRoomReportStatus), mirroring the
-- Audio-Room report model. Appends 7 new values to the existing
-- VideoRoomModerationActionType enum for the automated/force-disconnect and
-- room-level mute actions this phase introduces. No ban model/enum — the
-- Video Room has no ban feature (block already covers the blacklist need).
--
-- Hand-authored (NOT generated via `prisma migrate dev`, NOT applied to any
-- database). Modeled on prisma/schema/migrations/20260707081115_audio_rooms_moderation
-- and prisma/schema/migrations/20260720130000_video_rooms_phase1_domain for
-- column/index naming conventions.

-- CreateEnum
CREATE TYPE "VideoRoomReportReason" AS ENUM ('USER', 'MESSAGE', 'SPAM', 'HARASSMENT', 'ABUSE', 'FAKE_ACCOUNT', 'OTHER');

-- CreateEnum
CREATE TYPE "VideoRoomReportStatus" AS ENUM ('PENDING', 'REVIEWED', 'DISMISSED', 'ACTIONED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VideoRoomModerationActionType" ADD VALUE 'FORCE_DISCONNECT';
ALTER TYPE "VideoRoomModerationActionType" ADD VALUE 'REPORT_REVIEWED';
ALTER TYPE "VideoRoomModerationActionType" ADD VALUE 'ROOM_MUTED';
ALTER TYPE "VideoRoomModerationActionType" ADD VALUE 'ROOM_UNMUTED';
ALTER TYPE "VideoRoomModerationActionType" ADD VALUE 'AUTO_MUTED';
ALTER TYPE "VideoRoomModerationActionType" ADD VALUE 'AUTO_KICKED';
ALTER TYPE "VideoRoomModerationActionType" ADD VALUE 'AUTO_FLAGGED';

-- CreateTable
CREATE TABLE "video_room_reports" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "reporterId" UUID NOT NULL,
    "targetUserId" UUID NOT NULL,
    "messageId" UUID,
    "reason" "VideoRoomReportReason" NOT NULL,
    "description" TEXT,
    "status" "VideoRoomReportStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" UUID,
    "reviewedAt" TIMESTAMP(3),
    "resolutionAction" TEXT,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_room_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_warnings" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "moderatorId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "metadata" JSONB,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_room_warnings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_room_reports_roomId_status_idx" ON "video_room_reports"("roomId", "status");

-- CreateIndex
CREATE INDEX "video_room_reports_targetUserId_idx" ON "video_room_reports"("targetUserId");

-- CreateIndex
CREATE INDEX "video_room_reports_reporterId_idx" ON "video_room_reports"("reporterId");

-- CreateIndex
CREATE INDEX "video_room_warnings_roomId_userId_idx" ON "video_room_warnings"("roomId", "userId");

-- CreateIndex
CREATE INDEX "video_room_warnings_userId_idx" ON "video_room_warnings"("userId");
