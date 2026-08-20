-- Adds `reportId` to `platform_user_bans`, so a ban issued directly from a
-- report's "Ban" decision can be traced back to the report that caused it.
-- Nullable and additive — existing direct-ban callers (outside the report
-- flow) simply never set it. No backfill needed for existing rows.
--
-- Declared as native `UUID`, matching this table's other id/foreign-key-like
-- columns (converted from TEXT to UUID in
-- 20260819000000_platform_moderation_uuid_and_region_code_fix) and the
-- `@db.Uuid` declaration in the Prisma schema. Because the column is new,
-- no `USING ... ::uuid` cast is needed — there are no existing values.

-- AlterTable
ALTER TABLE "platform_user_bans" ADD COLUMN "reportId" UUID;
