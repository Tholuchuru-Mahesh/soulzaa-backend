-- Normalised geography for ranking and event definitions. The free-text country
-- and region columns stay as display labels; these are what eligibility,
-- routing and categorisation read.
ALTER TABLE "ranking_definitions" ADD COLUMN "countryId" UUID;
ALTER TABLE "ranking_definitions" ADD COLUMN "regionId" UUID;
ALTER TABLE "event_definitions" ADD COLUMN "countryId" UUID;
ALTER TABLE "event_definitions" ADD COLUMN "regionId" UUID;

ALTER TABLE "ranking_definitions" ADD CONSTRAINT "ranking_definitions_countryId_fkey"
  FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ranking_definitions" ADD CONSTRAINT "ranking_definitions_regionId_fkey"
  FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "event_definitions" ADD CONSTRAINT "event_definitions_countryId_fkey"
  FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "event_definitions" ADD CONSTRAINT "event_definitions_regionId_fkey"
  FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ranking_definitions_countryId_idx" ON "ranking_definitions"("countryId");
CREATE INDEX "ranking_definitions_regionId_idx" ON "ranking_definitions"("regionId");
CREATE INDEX "event_definitions_countryId_idx" ON "event_definitions"("countryId");
CREATE INDEX "event_definitions_regionId_idx" ON "event_definitions"("regionId");
