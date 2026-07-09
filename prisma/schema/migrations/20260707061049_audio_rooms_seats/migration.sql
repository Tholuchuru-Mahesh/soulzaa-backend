-- CreateEnum
CREATE TYPE "SeatType" AS ENUM ('OWNER', 'PREMIUM_ADMIN', 'SPEAKER');

-- CreateEnum
CREATE TYPE "SeatRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SeatInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SeatHistoryAction" AS ENUM ('SEAT_TAKEN', 'SEAT_LEFT', 'SEAT_MOVED', 'SPEAKER_REMOVED', 'SEAT_LOCKED', 'SEAT_UNLOCKED', 'SEAT_MUTED', 'SEAT_UNMUTED', 'ROOM_MUTED', 'ROOM_UNMUTED', 'REQUEST_CREATED', 'REQUEST_ACCEPTED', 'REQUEST_REJECTED', 'REQUEST_CANCELLED', 'INVITE_SENT', 'INVITE_ACCEPTED', 'INVITE_REJECTED', 'INVITE_EXPIRED', 'ROLE_GRANTED', 'ROLE_REVOKED', 'LAYOUT_CHANGED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RoomMemberRole" ADD VALUE 'PREMIUM_ADMIN';
ALTER TYPE "RoomMemberRole" ADD VALUE 'LISTENER';

-- AlterTable
ALTER TABLE "room_settings" ADD COLUMN     "isRoomMuted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "premiumAdminSeatCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "requireApprovalForSeat" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "speakerSeatCount" INTEGER NOT NULL DEFAULT 8;

-- CreateTable
CREATE TABLE "room_roles" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "RoomMemberRole" NOT NULL,
    "grantedBy" UUID,
    "expiresAt" TIMESTAMP(3),
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_seats" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "seatIndex" INTEGER NOT NULL,
    "seatType" "SeatType" NOT NULL,
    "occupantUserId" UUID,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "isMuted" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_seats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seat_requests" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "seatIndex" INTEGER,
    "status" "SeatRequestStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedBy" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seat_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seat_invitations" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "inviterId" UUID NOT NULL,
    "inviteeUserId" UUID NOT NULL,
    "seatIndex" INTEGER,
    "status" "SeatInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seat_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seat_queue" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "requestId" UUID,
    "enqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seat_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seat_history" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "actorId" UUID,
    "subjectUserId" UUID,
    "action" "SeatHistoryAction" NOT NULL,
    "seatIndex" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seat_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_roles_roomId_idx" ON "room_roles"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "room_roles_roomId_userId_key" ON "room_roles"("roomId", "userId");

-- CreateIndex
CREATE INDEX "room_seats_roomId_idx" ON "room_seats"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "room_seats_roomId_seatIndex_key" ON "room_seats"("roomId", "seatIndex");

-- CreateIndex
CREATE UNIQUE INDEX "room_seats_roomId_occupantUserId_key" ON "room_seats"("roomId", "occupantUserId");

-- CreateIndex
CREATE INDEX "seat_requests_roomId_status_idx" ON "seat_requests"("roomId", "status");

-- CreateIndex
CREATE INDEX "seat_requests_userId_idx" ON "seat_requests"("userId");

-- CreateIndex
CREATE INDEX "seat_invitations_roomId_status_idx" ON "seat_invitations"("roomId", "status");

-- CreateIndex
CREATE INDEX "seat_invitations_inviteeUserId_status_idx" ON "seat_invitations"("inviteeUserId", "status");

-- CreateIndex
CREATE INDEX "seat_queue_roomId_position_idx" ON "seat_queue"("roomId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "seat_queue_roomId_userId_key" ON "seat_queue"("roomId", "userId");

-- CreateIndex
CREATE INDEX "seat_history_roomId_idx" ON "seat_history"("roomId");

-- CreateIndex
CREATE INDEX "seat_history_action_idx" ON "seat_history"("action");
