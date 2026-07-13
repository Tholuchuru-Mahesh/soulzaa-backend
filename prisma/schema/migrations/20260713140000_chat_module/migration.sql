-- CreateEnum
CREATE TYPE "ConversationType" AS ENUM ('DIRECT');

-- CreateEnum
CREATE TYPE "DirectMessageType" AS ENUM ('TEXT', 'IMAGE', 'VOICE', 'VIDEO', 'FILE', 'GIF', 'STICKER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AttachmentType" AS ENUM ('IMAGE', 'VOICE', 'VIDEO', 'FILE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'NEW_MESSAGE';
ALTER TYPE "NotificationType" ADD VALUE 'CHAT_REQUEST';

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "type" "ConversationType" NOT NULL DEFAULT 'DIRECT',
    "pairKey" TEXT NOT NULL,
    "createdBy" UUID NOT NULL,
    "requestedBy" UUID,
    "acceptedAt" TIMESTAMP(3),
    "lastMessageId" UUID,
    "lastMessageAt" TIMESTAMP(3),
    "lastMessagePreview" TEXT,
    "lastMessageType" "DirectMessageType",
    "lastMessageSender" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_participants" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "lastReadMessageId" UUID,
    "lastReadMessageAt" TIMESTAMP(3),
    "lastDeliveredMessageId" UUID,
    "lastDeliveredMessageAt" TIMESTAMP(3),
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "isMuted" BOOLEAN NOT NULL DEFAULT false,
    "mutedUntil" TIMESTAMP(3),
    "draft" TEXT,
    "draftAt" TIMESTAMP(3),
    "clearedAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "direct_messages" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "senderId" UUID NOT NULL,
    "type" "DirectMessageType" NOT NULL DEFAULT 'TEXT',
    "content" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "replyToId" UUID,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "direct_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_attachments" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "type" "AttachmentType" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "thumbnailKey" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "waveform" INTEGER[],
    "filename" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_reactions" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_pairKey_key" ON "conversations"("pairKey");

-- CreateIndex
CREATE INDEX "conversations_lastMessageAt_idx" ON "conversations"("lastMessageAt");

-- CreateIndex
CREATE INDEX "conversation_participants_userId_isArchived_leftAt_idx" ON "conversation_participants"("userId", "isArchived", "leftAt");

-- CreateIndex
CREATE INDEX "conversation_participants_userId_isPinned_idx" ON "conversation_participants"("userId", "isPinned");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_participants_conversationId_userId_key" ON "conversation_participants"("conversationId", "userId");

-- CreateIndex
CREATE INDEX "direct_messages_conversationId_createdAt_idx" ON "direct_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "direct_messages_senderId_idx" ON "direct_messages"("senderId");

-- CreateIndex
CREATE UNIQUE INDEX "direct_messages_conversationId_clientId_key" ON "direct_messages"("conversationId", "clientId");

-- CreateIndex
CREATE INDEX "message_attachments_messageId_idx" ON "message_attachments"("messageId");

-- CreateIndex
CREATE INDEX "message_reactions_messageId_idx" ON "message_reactions"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "message_reactions_messageId_userId_emoji_key" ON "message_reactions"("messageId", "userId", "emoji");

-- AddForeignKey
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "direct_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "direct_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

