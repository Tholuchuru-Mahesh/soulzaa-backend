-- Backfill `googleProductId` on the nine active INR tiers — production data fix.
--
-- Why this exists: 2026-08-03-official-inr-coin-panel.sql inserted the nine
-- rupee tiers without `googleProductId` (the column is absent from its INSERT
-- column list), so all nine shipped as NULL. That was harmless until the buy
-- screen began hiding packages Play cannot sell:
--
--   lib/features/wallet/presentation/screens/buy_coins_screen.dart
--     state.packages.where((p) => p.isPurchasableOnAndroid)
--
-- With every row NULL, that filter removes the entire catalogue: the app still
-- receives all nine packages, renders the "Choose amount" heading, and then
-- draws an empty grid with a disabled button. It reads as a broken screen, not
-- as an empty one, because the API call actually succeeded.
--
-- The mapping is a straight lowercase of `code` — Play product IDs may only
-- contain a-z, 0-9, `_` and `.` and must start with a lowercase letter or
-- digit, so `IN_GOLD_100` cannot be reused verbatim. These are the same nine
-- IDs named in docs/superpowers/plans/2026-08-04-coin-in-app-purchase.md:
--   in_gold_100, in_gold_200, in_gold_500, in_gold_1000, in_gold_2000,
--   in_gold_5000, in_gold_10000, in_gold_20000, in_gold_40000
--
-- Why SQL and not scripts/backfill-google-product-ids.ts: the runtime image
-- copies only dist/, prisma/ and node_modules/ and prunes dev dependencies, so
-- neither scripts/ nor ts-node exists in the container. psql inside the
-- postgres container is the one tool that is actually present.
--
-- THIS FIXES DISPLAY, NOT PURCHASE. The tiles come back as soon as this runs,
-- priced from `priceAmount` because Play's own product details are only used as
-- an override when they load. Completing a purchase additionally requires the
-- nine products to exist in Play Console under these exact IDs — see the
-- prerequisites table in docs/superpowers/specs/2026-08-04-coin-in-app-purchase-design.md.
--
-- Usage on the EC2 host:
--   docker exec -i soulzaa-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < scripts/sql/2026-08-10-coin-package-play-product-ids.sql
--
-- Idempotent: only touches rows that are still NULL, so re-running is a no-op.

BEGIN;

-- Only NULL rows are touched. A tier whose ID was already set by hand (or by a
-- future Play Console rename) keeps whatever it has — this script must never
-- silently rewrite a SKU that real purchase_orders already reference.
UPDATE coin_packages
SET "googleProductId" = lower(code),
    "updatedAt"       = NOW()
WHERE "isActive"
  AND currency = 'INR'
  AND "googleProductId" IS NULL;

-- Refuse to commit a half-configured catalogue.
--
-- A storefront that is only partly sellable is the exact failure this script is
-- fixing, so assert the end state and roll back rather than leave some tiers
-- visible and others silently hidden.
DO $$
DECLARE
  still_null  INT;
  bad_format  INT;
  active_inr  INT;
BEGIN
  SELECT COUNT(*) INTO active_inr
    FROM coin_packages WHERE "isActive" AND currency = 'INR';

  SELECT COUNT(*) INTO still_null
    FROM coin_packages
   WHERE "isActive" AND currency = 'INR' AND "googleProductId" IS NULL;

  -- Mirrors Play's own product-ID rule. An invalid ID would pass the app's
  -- isPurchasableOnAndroid check and then fail inside the billing sheet, which
  -- is worse than the tile staying hidden.
  SELECT COUNT(*) INTO bad_format
    FROM coin_packages
   WHERE "isActive" AND currency = 'INR'
     AND "googleProductId" !~ '^[a-z0-9][a-z0-9_.]*$';

  IF active_inr <> 9 THEN
    RAISE EXCEPTION 'Expected 9 active INR tiers, found %', active_inr;
  END IF;
  IF still_null <> 0 THEN
    RAISE EXCEPTION '% active INR tier(s) still have no googleProductId', still_null;
  END IF;
  IF bad_format <> 0 THEN
    RAISE EXCEPTION '% googleProductId(s) are not valid Play product IDs', bad_format;
  END IF;
END $$;

COMMIT;

-- Verify — every row should now show a lowercase SKU:
--   SELECT code, coins, "priceAmount", "googleProductId" FROM coin_packages
--    WHERE "isActive" ORDER BY "sortOrder", coins;
