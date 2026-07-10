-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('FRIEND_REQUEST', 'FRIEND_ACCEPTED', 'NEW_FOLLOWER', 'ROOM_INVITE', 'GAME_INVITE', 'FAMILY_INVITE', 'PK_INVITE', 'EVENT_INVITE');

-- CreateEnum
CREATE TYPE "FriendRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InvitationType" AS ENUM ('AUDIO_ROOM', 'GAME', 'FAMILY', 'PK_BATTLE', 'EVENT');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PresenceStatus" AS ENUM ('OFFLINE', 'ONLINE', 'IN_ROOM', 'IN_GAME', 'IN_PK');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "actorId" UUID,
    "entityType" TEXT,
    "entityId" UUID,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "userId" UUID NOT NULL,
    "pushEnabled" BOOLEAN NOT NULL DEFAULT true,
    "friendEvents" BOOLEAN NOT NULL DEFAULT true,
    "followEvents" BOOLEAN NOT NULL DEFAULT true,
    "inviteEvents" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "friend_requests" (
    "id" UUID NOT NULL,
    "requesterId" UUID NOT NULL,
    "addresseeId" UUID NOT NULL,
    "status" "FriendRequestStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "friend_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "friendships" (
    "id" UUID NOT NULL,
    "userAId" UUID NOT NULL,
    "userBId" UUID NOT NULL,
    "isBestFriendA" BOOLEAN NOT NULL DEFAULT false,
    "isBestFriendB" BOOLEAN NOT NULL DEFAULT false,
    "interactionScore" INTEGER NOT NULL DEFAULT 0,
    "lastInteractionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friendships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follows" (
    "id" UUID NOT NULL,
    "followerId" UUID NOT NULL,
    "followingId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "type" "InvitationType" NOT NULL,
    "inviterId" UUID NOT NULL,
    "inviteeId" UUID NOT NULL,
    "targetId" UUID,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "presence_state" (
    "userId" UUID NOT NULL,
    "status" "PresenceStatus" NOT NULL DEFAULT 'OFFLINE',
    "currentRoomId" UUID,
    "lastSeenAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "presence_state_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "user_interactions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "peerId" UUID NOT NULL,
    "giftScore" INTEGER NOT NULL DEFAULT 0,
    "chatScore" INTEGER NOT NULL DEFAULT 0,
    "coPresenceScore" INTEGER NOT NULL DEFAULT 0,
    "totalScore" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");

-- CreateIndex
CREATE INDEX "friend_requests_addresseeId_status_idx" ON "friend_requests"("addresseeId", "status");

-- CreateIndex
CREATE INDEX "friend_requests_requesterId_status_idx" ON "friend_requests"("requesterId", "status");

-- CreateIndex
CREATE INDEX "friend_requests_status_expiresAt_idx" ON "friend_requests"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "friend_requests_requesterId_addresseeId_key" ON "friend_requests"("requesterId", "addresseeId");

-- CreateIndex
CREATE INDEX "friendships_userAId_idx" ON "friendships"("userAId");

-- CreateIndex
CREATE INDEX "friendships_userBId_idx" ON "friendships"("userBId");

-- CreateIndex
CREATE INDEX "friendships_userAId_interactionScore_idx" ON "friendships"("userAId", "interactionScore");

-- CreateIndex
CREATE INDEX "friendships_userBId_interactionScore_idx" ON "friendships"("userBId", "interactionScore");

-- CreateIndex
CREATE UNIQUE INDEX "friendships_userAId_userBId_key" ON "friendships"("userAId", "userBId");

-- CreateIndex
CREATE INDEX "follows_followingId_idx" ON "follows"("followingId");

-- CreateIndex
CREATE INDEX "follows_followerId_idx" ON "follows"("followerId");

-- CreateIndex
CREATE UNIQUE INDEX "follows_followerId_followingId_key" ON "follows"("followerId", "followingId");

-- CreateIndex
CREATE INDEX "invitations_inviteeId_status_idx" ON "invitations"("inviteeId", "status");

-- CreateIndex
CREATE INDEX "invitations_inviterId_status_idx" ON "invitations"("inviterId", "status");

-- CreateIndex
CREATE INDEX "invitations_status_expiresAt_idx" ON "invitations"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "presence_state_status_idx" ON "presence_state"("status");

-- CreateIndex
CREATE INDEX "user_interactions_userId_totalScore_idx" ON "user_interactions"("userId", "totalScore");

-- CreateIndex
CREATE UNIQUE INDEX "user_interactions_userId_peerId_key" ON "user_interactions"("userId", "peerId");
