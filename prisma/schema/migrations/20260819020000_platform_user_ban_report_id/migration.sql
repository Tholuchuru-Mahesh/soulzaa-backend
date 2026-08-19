-- Adds `reportId` to `platform_user_bans`, so a ban issued directly from a
-- report's "Ban" decision can be traced back to the report that caused it.
-- Nullable and additive — existing direct-ban callers (outside the report
-- flow) simply never set it. No backfill needed for existing rows.

-- AlterTable
ALTER TABLE "platform_user_bans" ADD COLUMN "reportId" TEXT;
