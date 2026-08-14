-- Agency (Coin Seller) inventory panel — the wholesale tiers an agency buys at.
--
-- Mirrors 2026-08-03-official-inr-coin-panel.sql, which set the *retail* panel
-- users buy from at a flat 2.5 coins per rupee. This is the *wholesale* panel:
-- a flat 2.75 coins per rupee, so an agency that resells at the retail rate
-- keeps 0.25 coins per rupee — a 10% margin. The two rates must move together;
-- if the retail panel is ever repriced, this one has to be repriced with it or
-- the margin silently inverts and agencies resell at a loss.
--
-- Why SQL and not a seeder service: same reason as the retail panel. The
-- runtime image copies only dist/, prisma/ and node_modules/ and prunes dev
-- dependencies, so neither scripts/ nor ts-node exists in the container. psql
-- inside the postgres container is the one tool actually present.
--
-- Usage on the EC2 host:
--   docker exec -i soulzaa-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     < 2026-08-15-agency-coin-panel.sql
--
-- Idempotent: re-running corrects rather than duplicates.

BEGIN;

-- The wholesale panel.
--
-- priceCurrency is INR throughout: these are rupee prices and an agency
-- billed in another currency must not be shown them.
INSERT INTO coin_seller_inventory_packages (
  id, code, name, "coinAmount", "priceAmount",
  "priceCurrency", "isActive", "sortOrder", "createdAt", "updatedAt"
)
VALUES
  (gen_random_uuid(), 'AGENCY_GOLD_100',   '275 Coins',        275, 100,   'INR', true, 0, NOW(), NOW()),
  (gen_random_uuid(), 'AGENCY_GOLD_200',   '550 Coins',        550, 200,   'INR', true, 1, NOW(), NOW()),
  (gen_random_uuid(), 'AGENCY_GOLD_500',   '1,375 Coins',     1375, 500,   'INR', true, 2, NOW(), NOW()),
  (gen_random_uuid(), 'AGENCY_GOLD_1000',  '2,750 Coins',     2750, 1000,  'INR', true, 3, NOW(), NOW()),
  (gen_random_uuid(), 'AGENCY_GOLD_2000',  '5,500 Coins',     5500, 2000,  'INR', true, 4, NOW(), NOW()),
  (gen_random_uuid(), 'AGENCY_GOLD_5000',  '13,750 Coins',   13750, 5000,  'INR', true, 5, NOW(), NOW()),
  (gen_random_uuid(), 'AGENCY_GOLD_10000', '27,500 Coins',   27500, 10000, 'INR', true, 6, NOW(), NOW()),
  (gen_random_uuid(), 'AGENCY_GOLD_20000', '55,000 Coins',   55000, 20000, 'INR', true, 7, NOW(), NOW()),
  (gen_random_uuid(), 'AGENCY_GOLD_40000', '1,10,000 Coins', 110000, 40000, 'INR', true, 8, NOW(), NOW())
ON CONFLICT (code) DO UPDATE SET
  name            = EXCLUDED.name,
  "coinAmount"    = EXCLUDED."coinAmount",
  "priceAmount"   = EXCLUDED."priceAmount",
  "priceCurrency" = EXCLUDED."priceCurrency",
  "isActive"      = true,
  "sortOrder"     = EXCLUDED."sortOrder",
  "updatedAt"     = NOW();

-- Refuse to commit a half-right catalogue.
--
-- This panel sells real money at wholesale. A transposed digit here is worse
-- than the migration failing, so assert the end state and roll the whole thing
-- back if it is wrong.
DO $$
DECLARE
  active_tiers  INT;
  wrong_rate    INT;
  under_retail  INT;
BEGIN
  SELECT COUNT(*) INTO active_tiers
    FROM coin_seller_inventory_packages WHERE "isActive";

  SELECT COUNT(*) INTO wrong_rate
    FROM coin_seller_inventory_packages
   WHERE "isActive" AND "coinAmount" <> "priceAmount" * 2.75;

  -- The wholesale rate must beat retail, or an agency loses money on every
  -- resale. Compared against the live retail panel rather than a literal, so
  -- this catches a retail repricing that forgot about wholesale.
  SELECT COUNT(*) INTO under_retail
    FROM coin_seller_inventory_packages w
   WHERE w."isActive"
     AND EXISTS (
       SELECT 1 FROM coin_packages r
        WHERE r."isActive"
          AND r.currency = 'INR'
          AND r."priceAmount" = w."priceAmount"
          AND (r.coins + r."bonusCoins") >= w."coinAmount"
     );

  IF active_tiers <> 9 THEN
    RAISE EXCEPTION 'Expected 9 active wholesale tiers, found %', active_tiers;
  END IF;
  IF wrong_rate <> 0 THEN
    RAISE EXCEPTION '% wholesale tier(s) are not 2.75 coins per rupee', wrong_rate;
  END IF;
  IF under_retail <> 0 THEN
    RAISE EXCEPTION
      '% wholesale tier(s) give no better rate than retail — agencies would resell at a loss',
      under_retail;
  END IF;
END $$;

COMMIT;

-- What the agency panel will now return:
--   SELECT code, "coinAmount", "priceAmount", "priceCurrency"
--     FROM coin_seller_inventory_packages
--    WHERE "isActive" ORDER BY "sortOrder";
