-- CreateEnum
CREATE TYPE "ChatReportStatusDm" AS ENUM ('PENDING', 'REVIEWED', 'DISMISSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DirectMessageType" ADD VALUE 'GIFT';
ALTER TYPE "DirectMessageType" ADD VALUE 'PROFILE_SHARE';
ALTER TYPE "DirectMessageType" ADD VALUE 'ROOM_INVITE';
ALTER TYPE "DirectMessageType" ADD VALUE 'CALL_LOG';

-- AlterTable
ALTER TABLE "conversation_participants" ADD COLUMN     "isFavorite" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "manualUnread" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "direct_messages" ADD COLUMN     "metadata" JSONB;

-- CreateTable
CREATE TABLE "direct_message_reports" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "messageId" UUID,
    "reporterId" UUID NOT NULL,
    "targetUserId" UUID NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "description" TEXT,
    "status" "ChatReportStatusDm" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "direct_message_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "direct_message_reports_status_createdAt_idx" ON "direct_message_reports"("status", "createdAt");

-- CreateIndex
CREATE INDEX "direct_message_reports_targetUserId_idx" ON "direct_message_reports"("targetUserId");

-- CreateIndex
CREATE INDEX "direct_message_reports_conversationId_idx" ON "direct_message_reports"("conversationId");

-- CreateIndex
CREATE INDEX "conversation_participants_userId_isFavorite_idx" ON "conversation_participants"("userId", "isFavorite");

