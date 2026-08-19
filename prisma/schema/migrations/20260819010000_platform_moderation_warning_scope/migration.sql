-- Adds `scope` to `platform_moderation_audit_logs`, recording whether a
-- WARNING_SENT row was a private (target-only) or room-wide broadcast
-- warning. Null for every other action type. Nullable and additive — no
-- backfill needed for existing rows.

-- CreateEnum
CREATE TYPE "PlatformWarningScope" AS ENUM ('PRIVATE', 'ROOM');

-- AlterTable
ALTER TABLE "platform_moderation_audit_logs" ADD COLUMN "scope" "PlatformWarningScope";
