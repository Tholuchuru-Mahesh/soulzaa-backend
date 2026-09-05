-- AlterEnum
-- Safe on PostgreSQL 12+; production runs 16 (docker-compose.prod.yml). The new
-- value is only added here, never used in this migration, which is the case
-- Postgres forbids inside a single transaction.
ALTER TYPE "NotificationType" ADD VALUE 'MODERATOR_TASK_COMPLETED';

-- AlterTable
-- Additive only. Every non-null column carries a DEFAULT, so existing rows
-- backfill without a separate UPDATE pass and the ALTER stays a metadata change.
ALTER TABLE "moderator_task_assignments" ADD COLUMN     "banReason" TEXT,
ADD COLUMN     "bannedUserIds" UUID[],
ADD COLUMN     "currentProgress" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN     "remarks" TEXT,
ADD COLUMN     "startDate" TIMESTAMP(3),
ADD COLUMN     "targetCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "targetUserId" UUID,
ADD COLUMN     "targetUserIds" UUID[],
ADD COLUMN     "taskType" TEXT NOT NULL DEFAULT 'GENERAL';

-- AlterTable
-- Relaxing NOT NULL only: a moderation action no longer has to originate in a
-- room. No existing row can violate a weaker constraint, so this cannot fail on
-- production data.
ALTER TABLE "platform_moderation_audit_logs" ALTER COLUMN "roomId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "platform_user_bans" ALTER COLUMN "originRoomId" DROP NOT NULL;
