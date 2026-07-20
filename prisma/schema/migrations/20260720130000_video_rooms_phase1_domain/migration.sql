-- Video Rooms — Phase 1 (VR-1): Database Design & Core Domain Model.
-- Extends the VR-0 foundation into the complete Video Room database domain:
--   • 6 new enums for streaming/creation/member state, 10 for seats/moderation/
--     media/snapshots; extends VideoRoomMemberRole (+ADMIN, +MODERATOR) and
--     VideoRoomLogAction (+ settings/role/theme/seat/moderation actions).
--   • ADD COLUMN (all nullable or defaulted → backward compatible) on
--     video_rooms / video_room_settings / video_room_members /
--     video_room_statistics.
--   • 13 new tables: roles, seats, seat_requests, invitations, mutes, blocks,
--     moderation_actions, sessions, events, snapshots, announcements, themes,
--     backgrounds.
-- Reuse-maximal: analytics (shared analytics module), categories/languages
-- (shared room_* reference, by value), and permissions (code matrix) get NO new
-- tables. No cross-domain foreign keys — references are by id + index. No room
-- BAN table (block covers the bar-from-room need).
--
-- Purely additive: no DROP/ALTER-of-existing-column/data-loss statements, so it
-- is backward compatible. Rollback = drop the new tables/columns/types.
-- Generated offline via `prisma migrate diff --from-schema-datamodel <VR-0
-- snapshot> --to-schema-datamodel prisma/schema --script` (no database
-- connection was made; NOT applied). See
-- docs/superpowers/specs/2026-07-20-video-room-phase1-database-design.md §9.

-- CreateEnum
CREATE TYPE "VideoRoomStreamingStatus" AS ENUM ('IDLE', 'PUBLISHING', 'PAUSED');

-- CreateEnum
CREATE TYPE "VideoRoomCreationSource" AS ENUM ('APP', 'WEB', 'API', 'SYSTEM');

-- CreateEnum
CREATE TYPE "VideoRoomMemberStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'LEFT', 'REMOVED');

-- CreateEnum
CREATE TYPE "VideoRoomSnapshotReason" AS ENUM ('PERIODIC', 'PRE_SHUTDOWN', 'MANUAL', 'RECOVERY');

-- CreateEnum
CREATE TYPE "VideoRoomPublishRole" AS ENUM ('PUBLISHER', 'SUBSCRIBER');

-- CreateEnum
CREATE TYPE "VideoRoomSessionStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "VideoRoomModerationMuteType" AS ENUM ('TEMPORARY', 'PERMANENT');

-- CreateEnum
CREATE TYPE "VideoRoomModerationStatus" AS ENUM ('ACTIVE', 'LIFTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "VideoRoomModerationActionType" AS ENUM ('MUTE_TEMPORARY', 'MUTE_PERMANENT', 'UNMUTE', 'BLOCK', 'UNBLOCK', 'KICK', 'WARN', 'ROLE_GRANTED', 'ROLE_REVOKED', 'ANNOUNCEMENT_POSTED', 'ANNOUNCEMENT_REMOVED');

-- CreateEnum
CREATE TYPE "VideoRoomSeatType" AS ENUM ('OWNER', 'HOST', 'GUEST');

-- CreateEnum
CREATE TYPE "VideoRoomSeatStatus" AS ENUM ('EMPTY', 'OCCUPIED', 'LOCKED', 'RESERVED');

-- CreateEnum
CREATE TYPE "VideoRoomSeatRequestType" AS ENUM ('TAKE_SEAT');

-- CreateEnum
CREATE TYPE "VideoRoomSeatRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "VideoRoomInvitationType" AS ENUM ('SEAT', 'ROOM');

-- CreateEnum
CREATE TYPE "VideoRoomInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VideoRoomMemberRole" ADD VALUE 'ADMIN';
ALTER TYPE "VideoRoomMemberRole" ADD VALUE 'MODERATOR';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VideoRoomLogAction" ADD VALUE 'SETTINGS_CHANGED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE 'ROLE_CHANGED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE 'THEME_CHANGED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE 'ANNOUNCEMENT_POSTED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE 'INVITED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE 'REQUEST_ACCEPTED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE 'REQUEST_REJECTED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE 'SEAT_TAKEN';
ALTER TYPE "VideoRoomLogAction" ADD VALUE 'SEAT_LEFT';
ALTER TYPE "VideoRoomLogAction" ADD VALUE 'MUTED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE 'UNMUTED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE 'BLOCKED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE 'UNBLOCKED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE 'KICKED';

-- AlterTable
ALTER TABLE "video_rooms" ADD COLUMN     "backgroundId" UUID,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "creationSource" "VideoRoomCreationSource" NOT NULL DEFAULT 'APP',
ADD COLUMN     "isVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "region" TEXT,
ADD COLUMN     "roomLevel" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "streamingStatus" "VideoRoomStreamingStatus" NOT NULL DEFAULT 'IDLE',
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "themeId" UUID;

-- AlterTable
ALTER TABLE "video_room_settings" ADD COLUMN     "allowAnnouncements" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowBeauty" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowCameraSwitch" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowFollow" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowInvite" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowJoinRequest" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowPk" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowRecording" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "allowReporting" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowScreenShare" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "allowShare" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowTreasure" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowViewerChat" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "guestSeatCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "hostSeatCount" INTEGER NOT NULL DEFAULT 9,
ADD COLUMN     "maxDurationMinutes" INTEGER,
ADD COLUMN     "slowModeSeconds" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "video_room_members" ADD COLUMN     "country" TEXT,
ADD COLUMN     "deviceId" UUID,
ADD COLUMN     "joinSource" TEXT,
ADD COLUMN     "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "memberStatus" "VideoRoomMemberStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "platform" TEXT,
ADD COLUMN     "region" TEXT;

-- AlterTable
ALTER TABLE "video_room_statistics" ADD COLUMN     "avgWatchTimeSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalChatMessages" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "totalGiftCoins" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "totalGifts" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "totalPkCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalSessions" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "video_room_events" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "actorId" UUID,
    "eventType" TEXT NOT NULL,
    "payload" JSONB,
    "referenceId" UUID,
    "correlationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_room_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_snapshots" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "reason" "VideoRoomSnapshotReason" NOT NULL DEFAULT 'PERIODIC',
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_room_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_announcements" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "video_room_announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_sessions" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "zegoRoomId" TEXT NOT NULL,
    "role" "VideoRoomPublishRole" NOT NULL DEFAULT 'SUBSCRIBER',
    "status" "VideoRoomSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "selfMutedAudio" BOOLEAN NOT NULL DEFAULT false,
    "selfMutedVideo" BOOLEAN NOT NULL DEFAULT false,
    "cameraFacing" TEXT,
    "deviceId" UUID,
    "platform" TEXT,
    "network" TEXT,
    "reconnectCount" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "durationSeconds" BIGINT NOT NULL DEFAULT 0,
    "lastQualityLevel" INTEGER,
    "avgRttMs" INTEGER,
    "worstRttMs" INTEGER,
    "avgPacketLossPct" DOUBLE PRECISION,
    "avgFrameRate" INTEGER,
    "avgBitrateKbps" INTEGER,
    "qualitySampleCount" INTEGER NOT NULL DEFAULT 0,
    "lastReportAt" TIMESTAMP(3),
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_room_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_mutes" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "moderatorId" UUID NOT NULL,
    "type" "VideoRoomModerationMuteType" NOT NULL,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "status" "VideoRoomModerationStatus" NOT NULL DEFAULT 'ACTIVE',
    "liftedBy" UUID,
    "liftedAt" TIMESTAMP(3),
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_room_mutes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_blocks" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "moderatorId" UUID NOT NULL,
    "reason" TEXT,
    "status" "VideoRoomModerationStatus" NOT NULL DEFAULT 'ACTIVE',
    "liftedBy" UUID,
    "liftedAt" TIMESTAMP(3),
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_room_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_moderation_actions" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "moderatorId" UUID,
    "targetUserId" UUID,
    "action" "VideoRoomModerationActionType" NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_room_moderation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_themes" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "previewKey" TEXT,
    "assetKey" TEXT,
    "isPremium" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_room_themes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_backgrounds" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageKey" TEXT,
    "isPremium" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_room_backgrounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_roles" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "VideoRoomMemberRole" NOT NULL,
    "grantedBy" UUID,
    "expiresAt" TIMESTAMP(3),
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_room_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_seats" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "seatIndex" INTEGER NOT NULL,
    "seatType" "VideoRoomSeatType" NOT NULL,
    "seatStatus" "VideoRoomSeatStatus" NOT NULL DEFAULT 'EMPTY',
    "occupantUserId" UUID,
    "reservedForUserId" UUID,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "isMuted" BOOLEAN NOT NULL DEFAULT false,
    "isVideoOn" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_room_seats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_seat_requests" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "seatIndex" INTEGER,
    "type" "VideoRoomSeatRequestType" NOT NULL DEFAULT 'TAKE_SEAT',
    "status" "VideoRoomSeatRequestStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedBy" UUID,
    "resolvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_room_seat_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_invitations" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "inviterId" UUID NOT NULL,
    "inviteeUserId" UUID NOT NULL,
    "type" "VideoRoomInvitationType" NOT NULL DEFAULT 'SEAT',
    "seatIndex" INTEGER,
    "status" "VideoRoomInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_room_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_room_events_roomId_idx" ON "video_room_events"("roomId");

-- CreateIndex
CREATE INDEX "video_room_events_eventType_idx" ON "video_room_events"("eventType");

-- CreateIndex
CREATE INDEX "video_room_events_correlationId_idx" ON "video_room_events"("correlationId");

-- CreateIndex
CREATE INDEX "video_room_snapshots_roomId_createdAt_idx" ON "video_room_snapshots"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "video_room_announcements_roomId_idx" ON "video_room_announcements"("roomId");

-- CreateIndex
CREATE INDEX "video_room_sessions_roomId_idx" ON "video_room_sessions"("roomId");

-- CreateIndex
CREATE INDEX "video_room_sessions_status_idx" ON "video_room_sessions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "video_room_sessions_roomId_userId_key" ON "video_room_sessions"("roomId", "userId");

-- CreateIndex
CREATE INDEX "video_room_mutes_roomId_status_idx" ON "video_room_mutes"("roomId", "status");

-- CreateIndex
CREATE INDEX "video_room_mutes_userId_status_idx" ON "video_room_mutes"("userId", "status");

-- CreateIndex
CREATE INDEX "video_room_mutes_status_expiresAt_idx" ON "video_room_mutes"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "video_room_blocks_roomId_status_idx" ON "video_room_blocks"("roomId", "status");

-- CreateIndex
CREATE INDEX "video_room_blocks_userId_status_idx" ON "video_room_blocks"("userId", "status");

-- CreateIndex
CREATE INDEX "video_room_moderation_actions_roomId_idx" ON "video_room_moderation_actions"("roomId");

-- CreateIndex
CREATE INDEX "video_room_moderation_actions_action_idx" ON "video_room_moderation_actions"("action");

-- CreateIndex
CREATE INDEX "video_room_moderation_actions_targetUserId_idx" ON "video_room_moderation_actions"("targetUserId");

-- CreateIndex
CREATE UNIQUE INDEX "video_room_themes_slug_key" ON "video_room_themes"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "video_room_backgrounds_slug_key" ON "video_room_backgrounds"("slug");

-- CreateIndex
CREATE INDEX "video_room_roles_roomId_idx" ON "video_room_roles"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "video_room_roles_roomId_userId_key" ON "video_room_roles"("roomId", "userId");

-- CreateIndex
CREATE INDEX "video_room_seats_roomId_idx" ON "video_room_seats"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "video_room_seats_roomId_seatIndex_key" ON "video_room_seats"("roomId", "seatIndex");

-- CreateIndex
CREATE UNIQUE INDEX "video_room_seats_roomId_occupantUserId_key" ON "video_room_seats"("roomId", "occupantUserId");

-- CreateIndex
CREATE INDEX "video_room_seat_requests_roomId_status_idx" ON "video_room_seat_requests"("roomId", "status");

-- CreateIndex
CREATE INDEX "video_room_seat_requests_userId_idx" ON "video_room_seat_requests"("userId");

-- CreateIndex
CREATE INDEX "video_room_invitations_roomId_status_idx" ON "video_room_invitations"("roomId", "status");

-- CreateIndex
CREATE INDEX "video_room_invitations_inviteeUserId_status_idx" ON "video_room_invitations"("inviteeUserId", "status");

-- CreateIndex
CREATE INDEX "video_rooms_language_idx" ON "video_rooms"("language");

-- CreateIndex
CREATE INDEX "video_rooms_country_idx" ON "video_rooms"("country");

-- CreateIndex
CREATE INDEX "video_rooms_createdAt_idx" ON "video_rooms"("createdAt");

-- CreateIndex
CREATE INDEX "video_rooms_status_visibility_idx" ON "video_rooms"("status", "visibility");

-- CreateIndex
CREATE INDEX "video_rooms_country_categoryId_idx" ON "video_rooms"("country", "categoryId");

-- CreateIndex
CREATE INDEX "video_rooms_tags_idx" ON "video_rooms" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "video_room_members_roomId_role_idx" ON "video_room_members"("roomId", "role");

