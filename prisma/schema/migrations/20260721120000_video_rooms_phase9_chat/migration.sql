-- VR-9: Video Room chat. PURELY ADDITIVE — no column or table is dropped.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE "VideoRoomMessageType" AS ENUM
  ('TEXT','EMOJI','GIF','IMAGE','VIDEO','VOICE','SYSTEM','ANNOUNCEMENT');
CREATE TYPE "VideoRoomChatMode" AS ENUM
  ('NORMAL','PARTICIPANTS_ONLY','READ_ONLY','ANNOUNCEMENT_ONLY');

ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'MESSAGE_DELETED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'MESSAGE_PINNED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'MESSAGE_UNPINNED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT_UPDATED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT_DELETED';

CREATE TABLE "video_room_messages" (
    "id"              UUID NOT NULL,
    "roomId"          UUID NOT NULL,
    "senderId"        UUID NOT NULL,
    "type"            "VideoRoomMessageType" NOT NULL DEFAULT 'TEXT',
    "content"         TEXT NOT NULL,
    "mentions"        UUID[],
    "mentionScope"    TEXT,
    "replyToId"       UUID,
    "forwardedFromId" UUID,
    "attachments"     JSONB,
    "metadata"        JSONB,
    "editedAt"        TIMESTAMP(3),
    "editCount"       INTEGER NOT NULL DEFAULT 0,
    "deletedAt"       TIMESTAMP(3),
    "deletedBy"       UUID,
    "recalledAt"      TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "video_room_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "video_room_messages_roomId_createdAt_idx"
  ON "video_room_messages" ("roomId", "createdAt" DESC);
CREATE INDEX "video_room_messages_roomId_type_createdAt_idx"
  ON "video_room_messages" ("roomId", "type", "createdAt" DESC);
CREATE INDEX "video_room_messages_roomId_senderId_createdAt_idx"
  ON "video_room_messages" ("roomId", "senderId", "createdAt" DESC);
CREATE INDEX "video_room_messages_replyToId_idx"
  ON "video_room_messages" ("replyToId");
CREATE INDEX "video_room_messages_mentions_idx"
  ON "video_room_messages" USING GIN ("mentions");
-- Keyword search stays indexed instead of sequential-scanning millions of rows.
CREATE INDEX "video_room_messages_content_trgm_idx"
  ON "video_room_messages" USING GIN ("content" gin_trgm_ops);

CREATE TABLE "video_room_message_pins" (
    "id"         UUID NOT NULL,
    "roomId"     UUID NOT NULL,
    "messageId"  UUID NOT NULL,
    "pinnedBy"   UUID NOT NULL,
    "isActive"   BOOLEAN NOT NULL DEFAULT true,
    "pinnedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unpinnedBy" UUID,
    "unpinnedAt" TIMESTAMP(3),
    CONSTRAINT "video_room_message_pins_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "video_room_message_pins_roomId_isActive_idx"
  ON "video_room_message_pins" ("roomId", "isActive");
CREATE INDEX "video_room_message_pins_messageId_idx"
  ON "video_room_message_pins" ("messageId");

CREATE TABLE "video_room_chat_cursors" (
    "roomId"                 UUID NOT NULL,
    "userId"                 UUID NOT NULL,
    "lastReadMessageId"      UUID,
    "lastReadAt"             TIMESTAMP(3),
    "lastDeliveredMessageId" UUID,
    "lastDeliveredAt"        TIMESTAMP(3),
    "updatedAt"              TIMESTAMP(3) NOT NULL,
    CONSTRAINT "video_room_chat_cursors_pkey" PRIMARY KEY ("roomId", "userId")
);
CREATE INDEX "video_room_chat_cursors_roomId_lastReadAt_idx"
  ON "video_room_chat_cursors" ("roomId", "lastReadAt");

-- Settings: new chat policy columns.
ALTER TABLE "video_room_settings"
  ADD COLUMN "chatMode" "VideoRoomChatMode" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "chatMaxMessageLength"   INTEGER NOT NULL DEFAULT 500,
  ADD COLUMN "chatMaxAttachments"     INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "chatRateLimitPerMinute" INTEGER NOT NULL DEFAULT 20;

-- Deprecation backfill: existing rooms keep their exact current behaviour.
-- allowViewerChat is NOT dropped (see the schema doc comment).
UPDATE "video_room_settings"
   SET "chatMode" = 'PARTICIPANTS_ONLY'
 WHERE "allowViewerChat" = false;
