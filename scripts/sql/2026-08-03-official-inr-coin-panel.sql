-- Official INR coin panel — production data fix.
--
-- Replaces the five USD tiers that CoinPackageSeederService used to write on
-- every API boot with the nine rupee tiers from the Soulzaaa Coin Economy doc
-- (a flat 2.5 coins per rupee).
--
-- Why SQL and not scripts/seed-coin-packages-inr.ts: the runtime image copies
-- only dist/, prisma/ and node_modules/, and prunes dev dependencies — so
-- neither scripts/ nor ts-node exists in the container. psql inside the
-- postgres container is the one tool that is actually present.
--
-- DEPLOY THE CODE FIRST — for the country fix, not this one. Users whose
-- countryId was never resolved (i.e. everyone, since nothing at signup sets it)
-- only saw GLOBAL packages, so these country='IN' rows stay invisible until
-- CoinPackageService ships its DEFAULT_STOREFRONT_COUNTRY fallback.
--
-- Step 1 below is safe against a restart of the OLD image either way: that
-- seeder upserts with `update: {}`, a no-op on rows that already exist, so a
-- deactivated row stays deactivated. A DELETEd row would have come straight
-- back — one more reason step 1 deactivates instead.
--
-- Usage on the EC2 host:
--   docker exec -i soulzaa-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     < 2026-08-03-official-inr-coin-panel.sql
--
-- Idempotent: re-running corrects rather than duplicates.

BEGIN;

-- 1. Retire the auto-seeded USD tiers.
--
-- Deactivated, NOT deleted. purchase_orders.packageId references this table
-- with onDelete: Restrict, so a DELETE would either fail outright or, if it
-- succeeded, sever the link between a real payment and what it bought.
-- isActive = false removes them from the storefront while the receipt history
-- stays intact and auditable.
UPDATE coin_packages
SET "isActive" = false,
    "updatedAt" = NOW()
WHERE code IN (
  'PKG_100_COINS',
  'PKG_500_COINS',
  'PKG_1000_COINS',
  'PKG_5000_COINS',
  'PKG_10000_COINS'
);

-- 2. The official panel.
--
-- country = 'IN', never 'GLOBAL': these are rupee prices and must not be shown
-- to users who cannot be charged in rupees. CoinPackageService pairs this with
-- DEFAULT_STOREFRONT_COUNTRY so users whose country was never resolved still
-- see them.
INSERT INTO coin_packages (
  id, code, name, coins, "bonusCoins", "priceAmount",
  currency, country, platform, "isActive", "sortOrder",
  "createdAt", "updatedAt"
)
VALUES
  (gen_random_uuid(), 'IN_GOLD_100',   '250 Coins',       250, 0,   100, 'INR', 'IN', 'ALL', true, 0, NOW(), NOW()),
  (gen_random_uuid(), 'IN_GOLD_200',   '500 Coins',       500, 0,   200, 'INR', 'IN', 'ALL', true, 1, NOW(), NOW()),
  (gen_random_uuid(), 'IN_GOLD_500',   '1,250 Coins',    1250, 0,   500, 'INR', 'IN', 'ALL', true, 2, NOW(), NOW()),
  (gen_random_uuid(), 'IN_GOLD_1000',  '2,500 Coins',    2500, 0,  1000, 'INR', 'IN', 'ALL', true, 3, NOW(), NOW()),
  (gen_random_uuid(), 'IN_GOLD_2000',  '5,000 Coins',    5000, 0,  2000, 'INR', 'IN', 'ALL', true, 4, NOW(), NOW()),
  (gen_random_uuid(), 'IN_GOLD_5000',  '12,500 Coins',  12500, 0,  5000, 'INR', 'IN', 'ALL', true, 5, NOW(), NOW()),
  (gen_random_uuid(), 'IN_GOLD_10000', '25,000 Coins',  25000, 0, 10000, 'INR', 'IN', 'ALL', true, 6, NOW(), NOW()),
  (gen_random_uuid(), 'IN_GOLD_20000', '50,000 Coins',  50000, 0, 20000, 'INR', 'IN', 'ALL', true, 7, NOW(), NOW()),
  (gen_random_uuid(), 'IN_GOLD_40000', '1,00,000 Coins', 100000, 0, 40000, 'INR', 'IN', 'ALL', true, 8, NOW(), NOW())
ON CONFLICT (code) DO UPDATE SET
  name          = EXCLUDED.name,
  coins         = EXCLUDED.coins,
  "bonusCoins"  = EXCLUDED."bonusCoins",
  "priceAmount" = EXCLUDED."priceAmount",
  currency      = EXCLUDED.currency,
  country       = EXCLUDED.country,
  platform      = EXCLUDED.platform,
  "isActive"    = true,
  "sortOrder"   = EXCLUDED."sortOrder",
  "updatedAt"   = NOW();

-- 3. Refuse to commit a half-right catalogue.
--
-- The storefront sells real money. A transposed digit or a USD row left active
-- is worse than the migration failing, so assert the end state and roll the
-- whole thing back if it is wrong.
DO $$
DECLARE
  active_inr  INT;
  active_usd  INT;
  wrong_rate  INT;
BEGIN
  SELECT COUNT(*) INTO active_inr
    FROM coin_packages WHERE currency = 'INR' AND "isActive";
  SELECT COUNT(*) INTO active_usd
    FROM coin_packages WHERE currency = 'USD' AND "isActive";
  SELECT COUNT(*) INTO wrong_rate
    FROM coin_packages
   WHERE currency = 'INR' AND "isActive" AND coins <> "priceAmount" * 2.5;

  IF active_inr <> 9 THEN
    RAISE EXCEPTION 'Expected 9 active INR tiers, found %', active_inr;
  END IF;
  IF active_usd <> 0 THEN
    RAISE EXCEPTION 'Still % active USD tier(s) — storefront would show dollars', active_usd;
  END IF;
  IF wrong_rate <> 0 THEN
    RAISE EXCEPTION '% INR tier(s) are not 2.5 coins per rupee', wrong_rate;
  END IF;
END $$;

COMMIT;

-- What the storefront will now return for an Indian (or unplaced) user:
--   SELECT code, coins, "priceAmount", currency FROM coin_packages
--    WHERE "isActive" AND (country = 'GLOBAL' OR country = 'IN')
--    ORDER BY "sortOrder", coins;
