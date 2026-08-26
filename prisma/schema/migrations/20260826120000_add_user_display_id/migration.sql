-- AlterTable: Add displayId to users
ALTER TABLE "users" ADD COLUMN "displayId" INTEGER;

-- Backfill existing users with sequential 8-digit numeric display IDs starting at 10000000
WITH numbered AS (
  SELECT id, (ROW_NUMBER() OVER (ORDER BY "createdAt" ASC) + 10000000 - 1)::INTEGER AS new_display_id
  FROM "users"
)
UPDATE "users" u
SET "displayId" = numbered.new_display_id
FROM numbered
WHERE u.id = numbered.id;

-- Make column NOT NULL after backfill
ALTER TABLE "users" ALTER COLUMN "displayId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "users_displayId_key" ON "users"("displayId");

-- CreateIndex
CREATE INDEX "users_displayId_idx" ON "users"("displayId");
