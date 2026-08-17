-- Drop Region from Moderator scoping and moderation snapshot columns.
--
-- Region stays as a table — EventDefinition, RankingDefinition, and
-- role-requests still depend on it and are untouched. Only the six
-- moderation-facing columns Phase 1 already stopped using (Moderator
-- RoleScope now stops at State) are removed here. Constraint/index names
-- confirmed directly against the live dev database's information_schema,
-- not reverse-engineered from migration history (this repo has pre-existing
-- migration/DB drift — see the "Prisma schema/client drift" project note).

-- users.regionId — real FK + dedicated index
ALTER TABLE "users" DROP CONSTRAINT "users_regionId_fkey";
DROP INDEX "users_regionId_idx";
ALTER TABLE "users" DROP COLUMN "regionId";

-- role_scopes.regionId — real FK, no dedicated index
ALTER TABLE "role_scopes" DROP CONSTRAINT "role_scopes_regionId_fkey";
ALTER TABLE "role_scopes" DROP COLUMN "regionId";

-- audio_rooms.region — plain denormalised column, no FK/index
ALTER TABLE "audio_rooms" DROP COLUMN "region";

-- video_rooms.region — plain denormalised column, no FK/index
ALTER TABLE "video_rooms" DROP COLUMN "region";

-- live_streams.regionId — plain denormalised column, no FK/index
ALTER TABLE "live_streams" DROP COLUMN "regionId";

-- investigation_recordings.regionId — plain denormalised column, no FK/index
ALTER TABLE "investigation_recordings" DROP COLUMN "regionId";

-- Legacy REGION-scoped RoleScope rows from earlier testing become dead rows
-- once regionId is gone (ScopeType.REGION is left in the enum, unused, to
-- avoid a higher-risk enum-recreation migration) — clean them up rather than
-- leave orphaned rows nothing will ever match again.
DELETE FROM "role_scopes" WHERE "scopeType" = 'REGION';
