-- CreateEnum
CREATE TYPE "MicSessionStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');

-- CreateEnum
CREATE TYPE "ContentRequestStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ContentRequestCategory" AS ENUM ('AUDIO_ROOM', 'LIVE_STREAM', 'PROFILE', 'POST', 'OTHER');

-- CreateEnum
CREATE TYPE "JackpotStatus" AS ENUM ('ACTIVE', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JackpotEntryStatus" AS ENUM ('ENTERED', 'WON', 'LOST', 'REFUNDED');

-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateEnum
CREATE TYPE "DeviceChangeRequestStatus" AS ENUM ('PENDING', 'MANAGER_REVIEWED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InvestigationStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "LiveStreamStatus" AS ENUM ('SCHEDULED', 'LIVE', 'PAUSED', 'ACTIVE', 'ENDED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ModeratorWarningLevel" AS ENUM ('LEVEL_1', 'LEVEL_2', 'LEVEL_3');

-- CreateEnum
CREATE TYPE "ModeratorWarningStatus" AS ENUM ('ACTIVE', 'RESOLVED');

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "SupportTicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "SupportTicketCategory" AS ENUM ('ACCOUNT', 'BILLING', 'CONTENT', 'TECHNICAL', 'ABUSE', 'OTHER');

-- CreateEnum
CREATE TYPE "VideoRoomBlockType" AS ENUM ('TEMPORARY', 'PERMANENT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DeviceEventType" ADD VALUE 'CHANGE_REQUESTED';
ALTER TYPE "DeviceEventType" ADD VALUE 'CHANGE_APPROVED';
ALTER TYPE "DeviceEventType" ADD VALUE 'CHANGE_REJECTED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'MODERATOR_SHIFT_STARTING';
ALTER TYPE "NotificationType" ADD VALUE 'MODERATOR_SHIFT_ENDING';
ALTER TYPE "NotificationType" ADD VALUE 'MODERATOR_TASK_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE 'MODERATOR_TASK_DUE_SOON';
ALTER TYPE "NotificationType" ADD VALUE 'MODERATOR_WARNING_ISSUED';
ALTER TYPE "NotificationType" ADD VALUE 'MODERATOR_HIGH_PRIORITY_REPORT';
ALTER TYPE "NotificationType" ADD VALUE 'MODERATOR_REPORT_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE 'MODERATOR_EMERGENCY_REQUEST';
ALTER TYPE "NotificationType" ADD VALUE 'MODERATOR_POLICY_UPDATE';
ALTER TYPE "NotificationType" ADD VALUE 'MODERATOR_OFFICIAL_MESSAGE';
ALTER TYPE "NotificationType" ADD VALUE 'MODERATOR_MANAGER_INSTRUCTION';
ALTER TYPE "NotificationType" ADD VALUE 'MODERATOR_SYSTEM_ANNOUNCEMENT';

-- AlterEnum
ALTER TYPE "PlatformRole" ADD VALUE 'CREATOR';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReportReason" ADD VALUE 'HATE_SPEECH';
ALTER TYPE "ReportReason" ADD VALUE 'BULLYING';
ALTER TYPE "ReportReason" ADD VALUE 'THREATS';
ALTER TYPE "ReportReason" ADD VALUE 'SEXUAL_CONTENT';
ALTER TYPE "ReportReason" ADD VALUE 'INAPPROPRIATE_CONTENT';

-- AlterEnum
ALTER TYPE "SessionEventType" ADD VALUE 'FAILED_LOGIN';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VideoRoomReportReason" ADD VALUE 'HATE_SPEECH';
ALTER TYPE "VideoRoomReportReason" ADD VALUE 'BULLYING';
ALTER TYPE "VideoRoomReportReason" ADD VALUE 'THREATS';
ALTER TYPE "VideoRoomReportReason" ADD VALUE 'SEXUAL_CONTENT';
ALTER TYPE "VideoRoomReportReason" ADD VALUE 'INAPPROPRIATE_CONTENT';

-- AlterTable
ALTER TABLE "attendance_ladder_rungs" ALTER COLUMN "currency" SET DEFAULT 'GAME';

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "browser" TEXT,
ADD COLUMN     "evidenceId" TEXT,
ADD COLUMN     "liveStreamId" UUID,
ADD COLUMN     "os" TEXT,
ADD COLUMN     "region" TEXT,
ADD COLUMN     "roomId" UUID,
ADD COLUMN     "targetUserId" UUID;

-- AlterTable
ALTER TABLE "platform_events" ADD COLUMN     "countryId" UUID,
ADD COLUMN     "regionId" UUID,
ADD COLUMN     "stateId" UUID;

-- AlterTable
ALTER TABLE "role_request_documents" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "room_reports" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assigneeId" UUID;

-- AlterTable
ALTER TABLE "video_room_blocks" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "type" "VideoRoomBlockType" NOT NULL DEFAULT 'PERMANENT';

-- AlterTable
ALTER TABLE "video_room_reports" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assigneeId" UUID;

-- CreateTable
CREATE TABLE "room_favorites" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_favorites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mic_sessions" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "seatIndex" INTEGER,
    "status" "MicSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mic_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "countryId" UUID,
    "stateId" UUID,
    "regionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_programs" (
    "id" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "countryId" UUID,
    "stateId" UUID,
    "regionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_requests" (
    "id" UUID NOT NULL,
    "officialId" UUID NOT NULL,
    "subjectId" UUID,
    "category" "ContentRequestCategory" NOT NULL DEFAULT 'OTHER',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "referenceId" TEXT,
    "status" "ContentRequestStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "closedById" UUID,
    "countryId" UUID,
    "stateId" UUID,
    "regionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jackpots" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "entryFee" BIGINT NOT NULL DEFAULT 500,
    "currentPool" BIGINT NOT NULL DEFAULT 0,
    "status" "JackpotStatus" NOT NULL DEFAULT 'ACTIVE',
    "winningEntryId" UUID,
    "winnerId" UUID,
    "rewardAmount" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "jackpots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jackpot_entries" (
    "id" UUID NOT NULL,
    "jackpotId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "entryFee" BIGINT NOT NULL,
    "status" "JackpotEntryStatus" NOT NULL DEFAULT 'ENTERED',
    "payoutAmount" BIGINT NOT NULL DEFAULT 0,
    "debitTxnId" UUID,
    "winTxnId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "jackpot_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_change_requests" (
    "id" UUID NOT NULL,
    "moderatorId" UUID NOT NULL,
    "oldDeviceId" UUID,
    "newDeviceInfo" JSONB NOT NULL,
    "reason" TEXT,
    "status" "DeviceChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "managerReviewedBy" UUID,
    "managerReviewedAt" TIMESTAMP(3),
    "managerReviewNote" TEXT,
    "reviewedBy" UUID,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_stream_moderation_actions" (
    "id" UUID NOT NULL,
    "streamId" UUID NOT NULL,
    "moderatorId" UUID NOT NULL,
    "targetUserId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "evidenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_stream_moderation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderator_task_assignments" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "moderatorId" UUID NOT NULL,
    "assignedBy" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "moderator_task_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investigation_recordings" (
    "id" UUID NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "moderatorId" UUID NOT NULL,
    "targetUserId" UUID NOT NULL,
    "roomId" UUID,
    "liveStreamId" UUID,
    "regionId" UUID,
    "violationReason" TEXT NOT NULL,
    "actionTaken" TEXT,
    "evidencePayload" JSONB,
    "status" "InvestigationStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "recordingUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "investigation_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_streams" (
    "id" UUID NOT NULL,
    "streamerId" UUID NOT NULL,
    "hostId" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "thumbnailKey" TEXT,
    "status" "LiveStreamStatus" NOT NULL DEFAULT 'SCHEDULED',
    "streamKey" TEXT,
    "viewerCount" INTEGER NOT NULL DEFAULT 0,
    "peakViewerCount" INTEGER NOT NULL DEFAULT 0,
    "countryId" UUID,
    "stateId" UUID,
    "regionId" UUID,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "live_streams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderator_daily_stats" (
    "id" UUID NOT NULL,
    "moderatorId" UUID NOT NULL,
    "dateKey" TEXT NOT NULL,
    "roomsVisited" INTEGER NOT NULL DEFAULT 0,
    "reportsReviewed" INTEGER NOT NULL DEFAULT 0,
    "reportsResolved" INTEGER NOT NULL DEFAULT 0,
    "reportsEscalated" INTEGER NOT NULL DEFAULT 0,
    "warningsIssued" INTEGER NOT NULL DEFAULT 0,
    "mutesIssued" INTEGER NOT NULL DEFAULT 0,
    "kicksIssued" INTEGER NOT NULL DEFAULT 0,
    "bansIssued" INTEGER NOT NULL DEFAULT 0,
    "falseModerationCount" INTEGER NOT NULL DEFAULT 0,
    "avgResolutionMinutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgResponseTime" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "performanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taskCompletionRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dailyTarget" INTEGER NOT NULL DEFAULT 20,
    "weeklyTarget" INTEGER NOT NULL DEFAULT 100,
    "monthlyTarget" INTEGER NOT NULL DEFAULT 400,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "moderator_daily_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderator_shifts" (
    "id" UUID NOT NULL,
    "moderatorId" UUID NOT NULL,
    "daysOfWeek" "DayOfWeek"[],
    "startHour" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endHour" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "assignedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "moderator_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_overrides" (
    "id" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "moderatorId" UUID NOT NULL,
    "overrideDate" DATE NOT NULL,
    "startHour" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endHour" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "reason" TEXT,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderator_warning_records" (
    "id" UUID NOT NULL,
    "moderatorId" UUID NOT NULL,
    "issuedBy" UUID NOT NULL,
    "level" "ModeratorWarningLevel" NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "status" "ModeratorWarningStatus" NOT NULL DEFAULT 'ACTIVE',
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" UUID,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "moderator_warning_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "submitterId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "SupportTicketCategory" NOT NULL DEFAULT 'OTHER',
    "priority" "SupportTicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "assignedOfficialId" UUID,
    "escalatedToAdminId" UUID,
    "countryId" UUID,
    "stateId" UUID,
    "regionId" UUID,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_messages" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "isStaff" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_audits" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_favorites_userId_idx" ON "room_favorites"("userId");

-- CreateIndex
CREATE INDEX "room_favorites_roomId_idx" ON "room_favorites"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "room_favorites_userId_roomId_key" ON "room_favorites"("userId", "roomId");

-- CreateIndex
CREATE INDEX "mic_sessions_userId_startedAt_idx" ON "mic_sessions"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "mic_sessions_roomId_startedAt_idx" ON "mic_sessions"("roomId", "startedAt");

-- CreateIndex
CREATE INDEX "mic_sessions_status_idx" ON "mic_sessions"("status");

-- CreateIndex
CREATE INDEX "campaigns_createdById_idx" ON "campaigns"("createdById");

-- CreateIndex
CREATE INDEX "campaigns_countryId_status_idx" ON "campaigns"("countryId", "status");

-- CreateIndex
CREATE INDEX "campaigns_stateId_status_idx" ON "campaigns"("stateId", "status");

-- CreateIndex
CREATE INDEX "campaigns_regionId_status_idx" ON "campaigns"("regionId", "status");

-- CreateIndex
CREATE INDEX "campaigns_startAt_endAt_idx" ON "campaigns"("startAt", "endAt");

-- CreateIndex
CREATE INDEX "community_programs_createdById_idx" ON "community_programs"("createdById");

-- CreateIndex
CREATE INDEX "community_programs_countryId_isActive_idx" ON "community_programs"("countryId", "isActive");

-- CreateIndex
CREATE INDEX "community_programs_stateId_isActive_idx" ON "community_programs"("stateId", "isActive");

-- CreateIndex
CREATE INDEX "content_requests_officialId_status_idx" ON "content_requests"("officialId", "status");

-- CreateIndex
CREATE INDEX "content_requests_countryId_status_idx" ON "content_requests"("countryId", "status");

-- CreateIndex
CREATE INDEX "content_requests_stateId_status_idx" ON "content_requests"("stateId", "status");

-- CreateIndex
CREATE INDEX "content_requests_regionId_status_idx" ON "content_requests"("regionId", "status");

-- CreateIndex
CREATE INDEX "jackpot_entries_userId_createdAt_idx" ON "jackpot_entries"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "jackpot_entries_jackpotId_idx" ON "jackpot_entries"("jackpotId");

-- CreateIndex
CREATE INDEX "device_change_requests_moderatorId_status_idx" ON "device_change_requests"("moderatorId", "status");

-- CreateIndex
CREATE INDEX "device_change_requests_status_idx" ON "device_change_requests"("status");

-- CreateIndex
CREATE INDEX "live_stream_moderation_actions_moderatorId_idx" ON "live_stream_moderation_actions"("moderatorId");

-- CreateIndex
CREATE INDEX "live_stream_moderation_actions_streamId_idx" ON "live_stream_moderation_actions"("streamId");

-- CreateIndex
CREATE INDEX "live_stream_moderation_actions_targetUserId_idx" ON "live_stream_moderation_actions"("targetUserId");

-- CreateIndex
CREATE INDEX "moderator_task_assignments_assignedBy_idx" ON "moderator_task_assignments"("assignedBy");

-- CreateIndex
CREATE INDEX "moderator_task_assignments_moderatorId_status_idx" ON "moderator_task_assignments"("moderatorId", "status");

-- CreateIndex
CREATE INDEX "moderator_task_assignments_status_dueAt_idx" ON "moderator_task_assignments"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "moderator_task_assignments_taskId_moderatorId_key" ON "moderator_task_assignments"("taskId", "moderatorId");

-- CreateIndex
CREATE UNIQUE INDEX "investigation_recordings_evidenceId_key" ON "investigation_recordings"("evidenceId");

-- CreateIndex
CREATE INDEX "investigation_recordings_moderatorId_idx" ON "investigation_recordings"("moderatorId");

-- CreateIndex
CREATE INDEX "investigation_recordings_targetUserId_idx" ON "investigation_recordings"("targetUserId");

-- CreateIndex
CREATE INDEX "investigation_recordings_liveStreamId_idx" ON "investigation_recordings"("liveStreamId");

-- CreateIndex
CREATE INDEX "investigation_recordings_roomId_idx" ON "investigation_recordings"("roomId");

-- CreateIndex
CREATE INDEX "investigation_recordings_status_idx" ON "investigation_recordings"("status");

-- CreateIndex
CREATE UNIQUE INDEX "live_streams_streamKey_key" ON "live_streams"("streamKey");

-- CreateIndex
CREATE INDEX "live_streams_status_idx" ON "live_streams"("status");

-- CreateIndex
CREATE INDEX "live_streams_streamerId_idx" ON "live_streams"("streamerId");

-- CreateIndex
CREATE INDEX "live_streams_hostId_idx" ON "live_streams"("hostId");

-- CreateIndex
CREATE INDEX "live_streams_status_stateId_idx" ON "live_streams"("status", "stateId");

-- CreateIndex
CREATE INDEX "live_streams_status_countryId_idx" ON "live_streams"("status", "countryId");

-- CreateIndex
CREATE INDEX "live_streams_createdAt_idx" ON "live_streams"("createdAt");

-- CreateIndex
CREATE INDEX "moderator_daily_stats_dateKey_idx" ON "moderator_daily_stats"("dateKey");

-- CreateIndex
CREATE INDEX "moderator_daily_stats_moderatorId_idx" ON "moderator_daily_stats"("moderatorId");

-- CreateIndex
CREATE UNIQUE INDEX "moderator_daily_stats_moderatorId_dateKey_key" ON "moderator_daily_stats"("moderatorId", "dateKey");

-- CreateIndex
CREATE INDEX "moderator_shifts_moderatorId_isActive_idx" ON "moderator_shifts"("moderatorId", "isActive");

-- CreateIndex
CREATE INDEX "shift_overrides_moderatorId_overrideDate_idx" ON "shift_overrides"("moderatorId", "overrideDate");

-- CreateIndex
CREATE UNIQUE INDEX "shift_overrides_shiftId_overrideDate_key" ON "shift_overrides"("shiftId", "overrideDate");

-- CreateIndex
CREATE INDEX "moderator_warning_records_issuedBy_idx" ON "moderator_warning_records"("issuedBy");

-- CreateIndex
CREATE INDEX "moderator_warning_records_level_idx" ON "moderator_warning_records"("level");

-- CreateIndex
CREATE INDEX "moderator_warning_records_moderatorId_status_idx" ON "moderator_warning_records"("moderatorId", "status");

-- CreateIndex
CREATE INDEX "support_tickets_status_stateId_idx" ON "support_tickets"("status", "stateId");

-- CreateIndex
CREATE INDEX "support_tickets_status_countryId_idx" ON "support_tickets"("status", "countryId");

-- CreateIndex
CREATE INDEX "support_tickets_assignedOfficialId_idx" ON "support_tickets"("assignedOfficialId");

-- CreateIndex
CREATE INDEX "support_tickets_submitterId_idx" ON "support_tickets"("submitterId");

-- CreateIndex
CREATE INDEX "support_tickets_createdAt_idx" ON "support_tickets"("createdAt");

-- CreateIndex
CREATE INDEX "support_ticket_messages_ticketId_createdAt_idx" ON "support_ticket_messages"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "support_ticket_audits_ticketId_createdAt_idx" ON "support_ticket_audits"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_targetUserId_idx" ON "audit_logs"("targetUserId");

-- CreateIndex
CREATE INDEX "audit_logs_roomId_idx" ON "audit_logs"("roomId");

-- CreateIndex
CREATE INDEX "audit_logs_evidenceId_idx" ON "audit_logs"("evidenceId");

-- CreateIndex
CREATE INDEX "platform_events_countryId_enabled_idx" ON "platform_events"("countryId", "enabled");

-- CreateIndex
CREATE INDEX "platform_events_stateId_enabled_idx" ON "platform_events"("stateId", "enabled");

-- CreateIndex
CREATE INDEX "room_reports_assigneeId_status_idx" ON "room_reports"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "video_room_blocks_status_expiresAt_idx" ON "video_room_blocks"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "video_room_reports_assigneeId_status_idx" ON "video_room_reports"("assigneeId", "status");

-- AddForeignKey
ALTER TABLE "jackpot_entries" ADD CONSTRAINT "jackpot_entries_jackpotId_fkey" FOREIGN KEY ("jackpotId") REFERENCES "jackpots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_stream_moderation_actions" ADD CONSTRAINT "live_stream_moderation_actions_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "live_streams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderator_task_assignments" ADD CONSTRAINT "moderator_task_assignments_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "task_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_overrides" ADD CONSTRAINT "shift_overrides_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "moderator_shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_audits" ADD CONSTRAINT "support_ticket_audits_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
