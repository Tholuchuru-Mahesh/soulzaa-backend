-- Follow-up to 20260818190000_platform_moderation_ban_and_audit.
-- That migration is already applied to the shared dev database, so it is
-- never edited in place (editing an applied migration's SQL changes its
-- checksum vs. what `_prisma_migrations` recorded, which is the same class
-- of drift that required manual reconciliation earlier in this project).
-- This migration corrects two issues raised in that task's code review
-- instead, as new, real DDL:
--
-- 1. `states.moderatorRegionCode` (prisma/schema/rbac.prisma:117) was left
--    as a commented-out, never-executed statement in the prior migration
--    because it was already applied to this specific dev database via an
--    out-of-band `db push` from unrelated, still-uncommitted moderator
--    state-scoping work. Left commented out, a fresh database (CI shadow
--    DB, new clone, production `migrate deploy`) replaying migration
--    history from empty would never create this column, even though
--    rbac.prisma declares it — a guaranteed failure of this repo's
--    `prisma-drift` CI job. Restated here as idempotent DDL (`IF NOT
--    EXISTS`) so it is a safe no-op on this already-patched dev database
--    and real, executable DDL everywhere else.
-- 2. `PlatformUserBan` / `PlatformModerationAuditLog` id and foreign-key-like
--    columns were declared as plain TEXT in the prior migration, diverging
--    from this codebase's convention of native `UUID` for such columns
--    (e.g. `ModeratorWarningRecord`). Both tables were created empty by the
--    prior migration and have no application code reading/writing them yet,
--    so converting column type here is safe — `USING ... ::uuid` casts no
--    existing rows.

-- AlterTable
ALTER TABLE "states" ADD COLUMN IF NOT EXISTS "moderatorRegionCode" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "states_moderatorRegionCode_key" ON "states"("moderatorRegionCode");

-- AlterTable
ALTER TABLE "platform_user_bans"
    ALTER COLUMN "id" TYPE UUID USING "id"::uuid,
    ALTER COLUMN "targetUserId" TYPE UUID USING "targetUserId"::uuid,
    ALTER COLUMN "moderatorId" TYPE UUID USING "moderatorId"::uuid,
    ALTER COLUMN "originRoomId" TYPE UUID USING "originRoomId"::uuid,
    ALTER COLUMN "liftedBy" TYPE UUID USING "liftedBy"::uuid;

-- AlterTable
ALTER TABLE "platform_moderation_audit_logs"
    ALTER COLUMN "id" TYPE UUID USING "id"::uuid,
    ALTER COLUMN "moderatorId" TYPE UUID USING "moderatorId"::uuid,
    ALTER COLUMN "roomId" TYPE UUID USING "roomId"::uuid,
    ALTER COLUMN "targetUserId" TYPE UUID USING "targetUserId"::uuid;
