-- Video Rooms — Phase 0 (VR-0): Enterprise Foundation.
-- Adds the video-room durable system-of-record: the `video_rooms` core table
-- plus `video_room_settings` / `video_room_members` / `video_room_statistics`
-- / `video_room_presence` / `video_room_logs`, and the VideoRoom* enums.
-- Reference data (room_categories / room_languages) is REUSED by value — no new
-- reference tables. Purely additive: no existing tables/columns/enums are
-- touched, so it is backward compatible.
--
-- Generated offline via `prisma migrate diff --from-schema-datamodel
-- <pre-change schema snapshot> --to-schema-datamodel prisma/schema --script`
-- (no database connection was made; NOT applied). See
-- docs/superpowers/specs/2026-07-20-video-room-phase0-design.md §4.

-- CreateEnum
CREATE TYPE "VideoRoomStatus" AS ENUM ('OFFLINE', 'LIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "VideoRoomVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "VideoRoomMemberRole" AS ENUM ('OWNER', 'HOST', 'PARTICIPANT', 'VIEWER');

-- CreateEnum
CREATE TYPE "VideoRoomLogAction" AS ENUM ('CREATED', 'UPDATED', 'DELETED', 'ENDED', 'JOINED', 'LEFT', 'LOCKED', 'UNLOCKED', 'OWNERSHIP_TRANSFERRED', 'IMAGE_UPDATED');

-- CreateTable
CREATE TABLE "video_rooms" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageKey" TEXT,
    "categoryId" UUID,
    "language" TEXT,
    "visibility" "VideoRoomVisibility" NOT NULL DEFAULT 'PUBLIC',
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "passwordHash" TEXT,
    "isDiscoverable" BOOLEAN NOT NULL DEFAULT true,
    "maxParticipants" INTEGER NOT NULL,
    "maxViewers" INTEGER NOT NULL,
    "status" "VideoRoomStatus" NOT NULL DEFAULT 'OFFLINE',
    "endedAt" TIMESTAMP(3),
    "zegoRoomId" TEXT,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "video_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_settings" (
    "roomId" UUID NOT NULL,
    "allowChat" BOOLEAN NOT NULL DEFAULT true,
    "allowGifts" BOOLEAN NOT NULL DEFAULT true,
    "joinApprovalRequired" BOOLEAN NOT NULL DEFAULT false,
    "isRoomMuted" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_room_settings_pkey" PRIMARY KEY ("roomId")
);

-- CreateTable
CREATE TABLE "video_room_members" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "VideoRoomMemberRole" NOT NULL DEFAULT 'VIEWER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_room_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_statistics" (
    "roomId" UUID NOT NULL,
    "peakViewers" INTEGER NOT NULL DEFAULT 0,
    "peakParticipants" INTEGER NOT NULL DEFAULT 0,
    "totalJoins" BIGINT NOT NULL DEFAULT 0,
    "currentViewers" INTEGER NOT NULL DEFAULT 0,
    "currentParticipants" INTEGER NOT NULL DEFAULT 0,
    "totalDurationSeconds" BIGINT NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_room_statistics_pkey" PRIMARY KEY ("roomId")
);

-- CreateTable
CREATE TABLE "video_room_presence" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "socketId" TEXT,
    "role" "VideoRoomMemberRole" NOT NULL DEFAULT 'VIEWER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_room_presence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_logs" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "actorId" UUID,
    "action" "VideoRoomLogAction" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_room_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "video_rooms_zegoRoomId_key" ON "video_rooms"("zegoRoomId");

-- CreateIndex
CREATE INDEX "video_rooms_status_idx" ON "video_rooms"("status");

-- CreateIndex
CREATE INDEX "video_rooms_ownerId_idx" ON "video_rooms"("ownerId");

-- CreateIndex
CREATE INDEX "video_rooms_categoryId_idx" ON "video_rooms"("categoryId");

-- CreateIndex
CREATE INDEX "video_rooms_visibility_isDiscoverable_status_idx" ON "video_rooms"("visibility", "isDiscoverable", "status");

-- CreateIndex
CREATE INDEX "video_room_members_roomId_idx" ON "video_room_members"("roomId");

-- CreateIndex
CREATE INDEX "video_room_members_userId_idx" ON "video_room_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "video_room_members_roomId_userId_key" ON "video_room_members"("roomId", "userId");

-- CreateIndex
CREATE INDEX "video_room_presence_roomId_idx" ON "video_room_presence"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "video_room_presence_roomId_userId_key" ON "video_room_presence"("roomId", "userId");

-- CreateIndex
CREATE INDEX "video_room_logs_roomId_idx" ON "video_room_logs"("roomId");

-- CreateIndex
CREATE INDEX "video_room_logs_action_idx" ON "video_room_logs"("action");

