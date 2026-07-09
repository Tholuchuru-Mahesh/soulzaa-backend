-- CreateEnum
CREATE TYPE "ModerationBanType" AS ENUM ('TEMPORARY', 'PERMANENT');

-- CreateEnum
CREATE TYPE "ModerationMuteType" AS ENUM ('TEMPORARY', 'PERMANENT');

-- CreateEnum
CREATE TYPE "ModerationStatus" AS ENUM ('ACTIVE', 'LIFTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('ABUSE', 'HARASSMENT', 'SPAM', 'FRAUD', 'FAKE_PROFILE', 'COPYRIGHT', 'ADULT_CONTENT', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'REVIEWED', 'DISMISSED', 'ACTIONED');

-- CreateEnum
CREATE TYPE "AppealStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ModerationActionType" AS ENUM ('KICK', 'BAN_TEMPORARY', 'BAN_PERMANENT', 'UNBAN', 'MUTE_TEMPORARY', 'MUTE_PERMANENT', 'UNMUTE', 'WARN', 'REPORT_REVIEWED', 'NOTE_ADDED', 'APPEAL_SUBMITTED', 'APPEAL_APPROVED', 'APPEAL_REJECTED');

-- CreateTable
CREATE TABLE "room_bans" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "moderatorId" UUID NOT NULL,
    "type" "ModerationBanType" NOT NULL,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "status" "ModerationStatus" NOT NULL DEFAULT 'ACTIVE',
    "liftedBy" UUID,
    "liftedAt" TIMESTAMP(3),
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_bans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_mutes" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "moderatorId" UUID NOT NULL,
    "type" "ModerationMuteType" NOT NULL,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "status" "ModerationStatus" NOT NULL DEFAULT 'ACTIVE',
    "liftedBy" UUID,
    "liftedAt" TIMESTAMP(3),
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_mutes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_actions" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "moderatorId" UUID,
    "targetUserId" UUID,
    "action" "ModerationActionType" NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_notes" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "targetUserId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_reports" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "reporterId" UUID NOT NULL,
    "targetUserId" UUID NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "description" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" UUID,
    "reviewedAt" TIMESTAMP(3),
    "resolutionAction" TEXT,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_appeals" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "banId" UUID,
    "muteId" UUID,
    "reason" TEXT NOT NULL,
    "status" "AppealStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" UUID,
    "reviewedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_appeals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_bans_roomId_status_idx" ON "room_bans"("roomId", "status");

-- CreateIndex
CREATE INDEX "room_bans_userId_status_idx" ON "room_bans"("userId", "status");

-- CreateIndex
CREATE INDEX "room_bans_status_expiresAt_idx" ON "room_bans"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "room_mutes_roomId_status_idx" ON "room_mutes"("roomId", "status");

-- CreateIndex
CREATE INDEX "room_mutes_userId_status_idx" ON "room_mutes"("userId", "status");

-- CreateIndex
CREATE INDEX "room_mutes_status_expiresAt_idx" ON "room_mutes"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "moderation_actions_roomId_idx" ON "moderation_actions"("roomId");

-- CreateIndex
CREATE INDEX "moderation_actions_action_idx" ON "moderation_actions"("action");

-- CreateIndex
CREATE INDEX "moderation_actions_targetUserId_idx" ON "moderation_actions"("targetUserId");

-- CreateIndex
CREATE INDEX "moderation_notes_roomId_targetUserId_idx" ON "moderation_notes"("roomId", "targetUserId");

-- CreateIndex
CREATE INDEX "room_reports_roomId_status_idx" ON "room_reports"("roomId", "status");

-- CreateIndex
CREATE INDEX "room_reports_targetUserId_idx" ON "room_reports"("targetUserId");

-- CreateIndex
CREATE INDEX "room_reports_reporterId_idx" ON "room_reports"("reporterId");

-- CreateIndex
CREATE INDEX "room_appeals_status_idx" ON "room_appeals"("status");

-- CreateIndex
CREATE INDEX "room_appeals_userId_idx" ON "room_appeals"("userId");

-- CreateIndex
CREATE INDEX "room_appeals_banId_idx" ON "room_appeals"("banId");

-- CreateIndex
CREATE INDEX "room_appeals_muteId_idx" ON "room_appeals"("muteId");
