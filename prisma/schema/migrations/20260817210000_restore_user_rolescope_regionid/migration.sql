-- Restores User.regionId and RoleScope.regionId, dropped by
-- 20260817200000_drop_region_from_moderation. That migration's research was
-- scoped to moderation call sites only; a full typecheck afterward showed
-- both columns are actually consumed well beyond moderation — role-request
-- routing, campaigns, events, content-requests, support tickets, and the
-- super-admin Official/Country-Manager RoleScope assignment flow. Those stay
-- on Region; only Moderator RoleScope allocation moved to State (unchanged
-- by this migration — AudioRoom.region, VideoRoom.region, LiveStream.regionId
-- and InvestigationRecording.regionId stay dropped, confirmed moderation-only
-- by three separate research passes).
--
-- Column data lost in the original DROP COLUMN cannot be recovered (no
-- backup) — these are added back empty and will need repopulating (the
-- affected rows are local dev/test data, not production).

ALTER TABLE "users" ADD COLUMN "regionId" UUID;
ALTER TABLE "users" ADD CONSTRAINT "users_regionId_fkey"
  FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "users_regionId_idx" ON "users"("regionId");

ALTER TABLE "role_scopes" ADD COLUMN "regionId" UUID;
ALTER TABLE "role_scopes" ADD CONSTRAINT "role_scopes_regionId_fkey"
  FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
