-- Chat Part 4 addendum: starred messages, a pinned thread banner, per-message
-- "delete for me", link previews, and a per-user wallpaper.
--
-- Entirely additive. Every new column is nullable or defaulted and every new
-- table is new, so this is safe to deploy ahead of the clients that use it — an
-- older client simply never reads the new fields.

-- ---------------------------------------------------------------- link previews

CREATE TYPE "LinkPreviewStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

CREATE TABLE "link_previews" (
    "id" UUID NOT NULL,
    "urlHash" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "siteName" TEXT,
    "imageKey" TEXT,
    "imageWidth" INTEGER,
    "imageHeight" INTEGER,
    "status" "LinkPreviewStatus" NOT NULL DEFAULT 'PENDING',
    "fetchedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "link_previews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "link_previews_urlHash_key" ON "link_previews"("urlHash");
CREATE INDEX "link_previews_expiresAt_idx" ON "link_previews"("expiresAt");

-- ------------------------------------------------------------ starred messages

CREATE TABLE "starred_messages" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "starred_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "starred_messages_messageId_userId_key"
    ON "starred_messages"("messageId", "userId");
CREATE INDEX "starred_messages_userId_createdAt_idx"
    ON "starred_messages"("userId", "createdAt" DESC);
CREATE INDEX "starred_messages_userId_conversationId_createdAt_idx"
    ON "starred_messages"("userId", "conversationId", "createdAt" DESC);

-- ------------------------------------------------- hidden messages (delete-for-me)

CREATE TABLE "hidden_messages" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hidden_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "hidden_messages_messageId_userId_key"
    ON "hidden_messages"("messageId", "userId");
-- Serves the history anti-join: "every message in this conversation NOT hidden by me".
CREATE INDEX "hidden_messages_userId_conversationId_idx"
    ON "hidden_messages"("userId", "conversationId");

-- --------------------------------------------------------------- message columns

ALTER TABLE "direct_messages" ADD COLUMN "linkPreviewId" UUID;
CREATE INDEX "direct_messages_linkPreviewId_idx" ON "direct_messages"("linkPreviewId");

-- ----------------------------------------------------------- conversation columns
--
-- The pinned *message* banner. Distinct from `conversation_participants.isPinned`,
-- which pins the conversation in the Chats list.

ALTER TABLE "conversations" ADD COLUMN "pinnedMessageId" UUID;
ALTER TABLE "conversations" ADD COLUMN "pinnedBy" UUID;
ALTER TABLE "conversations" ADD COLUMN "pinnedAt" TIMESTAMP(3);

-- ----------------------------------------------------------- participant columns

ALTER TABLE "conversation_participants" ADD COLUMN "wallpaper" TEXT;

-- ------------------------------------------------------------------ foreign keys
--
-- Star and hide cascade from the message: a hard-deleted message must not leave
-- orphan rows behind. The message -> link_preview link is SET NULL, because a
-- preview is shared across every message quoting the same URL and must outlive
-- any one of them.

ALTER TABLE "starred_messages" ADD CONSTRAINT "starred_messages_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "direct_messages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "hidden_messages" ADD CONSTRAINT "hidden_messages_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "direct_messages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_linkPreviewId_fkey"
    FOREIGN KEY ("linkPreviewId") REFERENCES "link_previews"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
