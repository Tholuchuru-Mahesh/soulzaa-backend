-- Reliability layer (Part 7): delta-sync timestamps + real notification preferences.
--
-- `updatedAt` is added in three steps rather than as a plain `NOT NULL` column:
-- these tables already hold rows, and a NOT NULL column with no default cannot be
-- added to a non-empty table. Backfilling from the best timestamp each row already
-- carries also means the very first `GET /chat/sync?since=` after deploy returns a
-- truthful delta instead of claiming every historical row changed just now.

-- ---- direct_messages.updatedAt ----
ALTER TABLE "direct_messages" ADD COLUMN "updatedAt" TIMESTAMP(3);

UPDATE "direct_messages"
SET "updatedAt" = GREATEST("createdAt", COALESCE("editedAt", "createdAt"), COALESCE("deletedAt", "createdAt"));

ALTER TABLE "direct_messages" ALTER COLUMN "updatedAt" SET NOT NULL;

-- ---- conversation_participants.updatedAt ----
ALTER TABLE "conversation_participants" ADD COLUMN "updatedAt" TIMESTAMP(3);

UPDATE "conversation_participants"
SET "updatedAt" = GREATEST(
  "joinedAt",
  COALESCE("lastReadMessageAt", "joinedAt"),
  COALESCE("lastDeliveredMessageAt", "joinedAt"),
  COALESCE("draftAt", "joinedAt"),
  COALESCE("clearedAt", "joinedAt")
);

ALTER TABLE "conversation_participants" ALTER COLUMN "updatedAt" SET NOT NULL;

-- ---- A gift is now something you get told about ----
-- Safe inside the migration's transaction on PG 12+: the value is only *added*
-- here, never used, and it is the use that would need it to be committed first.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GIFT_RECEIVED';

-- ---- notification_preferences: the columns that make the table more than decoration ----
ALTER TABLE "notification_preferences"
  ADD COLUMN "messageEvents" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "callEvents"    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "giftEvents"    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "systemEvents"  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "sound"         BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "vibration"     BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "showPreview"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "mutedUntil"    TIMESTAMP(3);

-- ---- Delta-sync indexes ----
CREATE INDEX "direct_messages_conversationId_updatedAt_idx" ON "direct_messages"("conversationId", "updatedAt");
CREATE INDEX "conversation_participants_userId_updatedAt_idx" ON "conversation_participants"("userId", "updatedAt");
CREATE INDEX "hidden_messages_userId_createdAt_idx" ON "hidden_messages"("userId", "createdAt");
