-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('LIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "RoomVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "RoomMemberRole" AS ENUM ('OWNER', 'ADMIN', 'SPEAKER', 'AUDIENCE');

-- CreateEnum
CREATE TYPE "RoomLogAction" AS ENUM ('CREATED', 'UPDATED', 'DELETED', 'ENDED', 'JOINED', 'LEFT', 'LOCKED', 'UNLOCKED', 'OWNERSHIP_TRANSFERRED', 'IMAGE_UPDATED');

-- CreateTable
CREATE TABLE "audio_rooms" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageKey" TEXT,
    "categoryId" UUID,
    "language" TEXT,
    "visibility" "RoomVisibility" NOT NULL DEFAULT 'PUBLIC',
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "passwordHash" TEXT,
    "isDiscoverable" BOOLEAN NOT NULL DEFAULT true,
    "maxParticipants" INTEGER NOT NULL,
    "status" "RoomStatus" NOT NULL DEFAULT 'LIVE',
    "endedAt" TIMESTAMP(3),
    "agoraChannel" TEXT NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "audio_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_settings" (
    "roomId" UUID NOT NULL,
    "allowChat" BOOLEAN NOT NULL DEFAULT true,
    "allowGifts" BOOLEAN NOT NULL DEFAULT true,
    "chatSlowModeSeconds" INTEGER NOT NULL DEFAULT 0,
    "joinApprovalRequired" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_settings_pkey" PRIMARY KEY ("roomId")
);

-- CreateTable
CREATE TABLE "room_members" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "RoomMemberRole" NOT NULL DEFAULT 'AUDIENCE',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_categories" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "iconKey" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_languages" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nativeName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_languages_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "room_statistics" (
    "roomId" UUID NOT NULL,
    "peakParticipants" INTEGER NOT NULL DEFAULT 0,
    "totalJoins" BIGINT NOT NULL DEFAULT 0,
    "currentParticipants" INTEGER NOT NULL DEFAULT 0,
    "totalDurationSeconds" BIGINT NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_statistics_pkey" PRIMARY KEY ("roomId")
);

-- CreateTable
CREATE TABLE "room_presence" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "socketId" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_presence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_logs" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "actorId" UUID,
    "action" "RoomLogAction" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audio_rooms_agoraChannel_key" ON "audio_rooms"("agoraChannel");

-- CreateIndex
CREATE INDEX "audio_rooms_ownerId_idx" ON "audio_rooms"("ownerId");

-- CreateIndex
CREATE INDEX "audio_rooms_status_idx" ON "audio_rooms"("status");

-- CreateIndex
CREATE INDEX "audio_rooms_categoryId_idx" ON "audio_rooms"("categoryId");

-- CreateIndex
CREATE INDEX "audio_rooms_visibility_isDiscoverable_status_idx" ON "audio_rooms"("visibility", "isDiscoverable", "status");

-- CreateIndex
CREATE INDEX "room_members_roomId_idx" ON "room_members"("roomId");

-- CreateIndex
CREATE INDEX "room_members_userId_idx" ON "room_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "room_members_roomId_userId_key" ON "room_members"("roomId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "room_categories_slug_key" ON "room_categories"("slug");

-- CreateIndex
CREATE INDEX "room_presence_roomId_idx" ON "room_presence"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "room_presence_roomId_userId_key" ON "room_presence"("roomId", "userId");

-- CreateIndex
CREATE INDEX "room_logs_roomId_idx" ON "room_logs"("roomId");

-- CreateIndex
CREATE INDEX "room_logs_action_idx" ON "room_logs"("action");
