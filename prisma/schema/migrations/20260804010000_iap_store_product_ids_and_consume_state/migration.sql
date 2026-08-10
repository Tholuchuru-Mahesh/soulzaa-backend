-- Google Play / App Store in-app purchase support.
--
-- Purely additive. Every column is nullable, so existing rows stay valid and no
-- data is modified or removed.
--
--   coin_packages.googleProductId  Play in-app product ID. Play requires
--                                  lowercase `[a-z0-9_.]`, so this cannot reuse
--                                  `code` (`IN_GOLD_100`). NULL means the
--                                  package is not sellable on Android and the
--                                  client hides it.
--   coin_packages.appleProductId   App Store product ID. NULL until the iOS spec
--                                  lands.
--   purchase_orders.consumedAt     When Play acknowledged the consume for this
--                                  order's purchase token. NULL on a COMPLETED
--                                  Google Play order means the consume never
--                                  landed — the SKU is still owned-and-unconsumed
--                                  in Play, so the user can neither re-buy that
--                                  tier nor stop restorePurchases() redelivering
--                                  it. PurchaseReconciliationService sweeps
--                                  exactly this set and retries.
--
-- Both product-ID columns are UNIQUE: one store SKU must never map to two
-- packages, or a single verified receipt would be ambiguous about what it paid
-- for. UNIQUE on a nullable column still permits many NULLs in PostgreSQL, which
-- is what lets every not-yet-listed package leave them empty.
--
-- IF NOT EXISTS throughout keeps the migration re-runnable, which matters
-- because `prisma migrate deploy` runs on every container start (see Dockerfile
-- CMD).

-- AlterTable
ALTER TABLE "coin_packages"
  ADD COLUMN IF NOT EXISTS "googleProductId" TEXT,
  ADD COLUMN IF NOT EXISTS "appleProductId" TEXT;

-- AlterTable
ALTER TABLE "purchase_orders"
  ADD COLUMN IF NOT EXISTS "consumedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "coin_packages_googleProductId_key" ON "coin_packages"("googleProductId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "coin_packages_appleProductId_key" ON "coin_packages"("appleProductId");

-- CreateIndex
-- Backs the consume-retry sweep's exact predicate
-- (status = 'COMPLETED' AND provider = 'GOOGLE_PLAY' AND "consumedAt" IS NULL),
-- which otherwise degrades into a full scan of purchase_orders as the table grows.
CREATE INDEX IF NOT EXISTS "purchase_orders_status_provider_consumedAt_idx" ON "purchase_orders"("status", "provider", "consumedAt");
