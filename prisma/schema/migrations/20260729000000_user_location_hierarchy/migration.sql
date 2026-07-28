-- Normalised user location for geographic scope filtering.
-- Nullable with no default: adding a nullable column without a default is a
-- catalogue-only change in Postgres, so this does not rewrite or long-lock the
-- users table. Backfill runs separately (UserLocationService.backfill).
ALTER TABLE "users" ADD COLUMN "countryId" UUID;
ALTER TABLE "users" ADD COLUMN "stateId" UUID;
ALTER TABLE "users" ADD COLUMN "regionId" UUID;

-- ON DELETE SET NULL: removing a region must not delete the people in it.
ALTER TABLE "users" ADD CONSTRAINT "users_countryId_fkey"
  FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_stateId_fkey"
  FOREIGN KEY ("stateId") REFERENCES "states"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_regionId_fkey"
  FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Scope filters query these directly; without indexes every scoped list is a
-- full scan of users.
CREATE INDEX "users_countryId_idx" ON "users"("countryId");
CREATE INDEX "users_stateId_idx" ON "users"("stateId");
CREATE INDEX "users_regionId_idx" ON "users"("regionId");
