-- CreateEnum
CREATE TYPE "ChatMessageType" AS ENUM ('TEXT', 'EMOJI', 'GIF', 'ANNOUNCEMENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "BlockedWordSeverity" AS ENUM ('MILD', 'OFFENSIVE', 'CRITICAL');

-- CreateEnum
CREATE TYPE "BlockedWordAction" AS ENUM ('MASK', 'REJECT', 'ESCALATE');

-- CreateEnum
CREATE TYPE "ChatReportStatus" AS ENUM ('PENDING', 'REVIEWED', 'DISMISSED', 'ACTIONED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ModerationActionType" ADD VALUE 'CHAT_MESSAGE_DELETED';
ALTER TYPE "ModerationActionType" ADD VALUE 'CHAT_WORD_MASKED';
ALTER TYPE "ModerationActionType" ADD VALUE 'CHAT_WORD_REJECTED';
ALTER TYPE "ModerationActionType" ADD VALUE 'CHAT_WORD_ESCALATED';
ALTER TYPE "ModerationActionType" ADD VALUE 'CHAT_AUTO_MUTED';
ALTER TYPE "ModerationActionType" ADD VALUE 'CHAT_AUTO_KICKED';

-- CreateTable
CREATE TABLE "room_messages" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "senderId" UUID NOT NULL,
    "type" "ChatMessageType" NOT NULL DEFAULT 'TEXT',
    "content" TEXT NOT NULL,
    "gifUrl" TEXT,
    "mentions" UUID[],
    "replyToId" UUID,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedBy" UUID,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pinned_messages" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "pinnedBy" UUID NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unpinnedBy" UUID,
    "unpinnedAt" TIMESTAMP(3),

    CONSTRAINT "pinned_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_reports" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "reporterId" UUID NOT NULL,
    "targetUserId" UUID NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "description" TEXT,
    "status" "ChatReportStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" UUID,
    "reviewedAt" TIMESTAMP(3),
    "resolutionAction" TEXT,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_blocked_words" (
    "id" UUID NOT NULL,
    "pattern" TEXT NOT NULL,
    "isRegex" BOOLEAN NOT NULL DEFAULT false,
    "language" TEXT NOT NULL DEFAULT 'en',
    "severity" "BlockedWordSeverity" NOT NULL,
    "action" "BlockedWordAction" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_blocked_words_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_messages_roomId_createdAt_idx" ON "room_messages"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "room_messages_senderId_idx" ON "room_messages"("senderId");

-- CreateIndex
CREATE INDEX "pinned_messages_roomId_isActive_idx" ON "pinned_messages"("roomId", "isActive");

-- CreateIndex
CREATE INDEX "chat_reports_roomId_status_idx" ON "chat_reports"("roomId", "status");

-- CreateIndex
CREATE INDEX "chat_reports_messageId_idx" ON "chat_reports"("messageId");

-- CreateIndex
CREATE INDEX "chat_reports_reporterId_idx" ON "chat_reports"("reporterId");

-- CreateIndex
CREATE INDEX "chat_blocked_words_enabled_idx" ON "chat_blocked_words"("enabled");

-- CreateIndex
CREATE INDEX "chat_blocked_words_language_idx" ON "chat_blocked_words"("language");
