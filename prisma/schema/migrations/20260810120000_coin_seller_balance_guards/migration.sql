-- Non-negative guards for Coin Seller inventory and the platform treasury.
--
-- The application already refuses to over-sell (a FOR UPDATE row lock plus a
-- balance re-read in CoinSellerUserSaleService), but PRD §18 asks for
-- database-level consistency rather than application-level checks alone:
--
--   "Two simultaneous sales must not cause inventory to become negative."
--   "Do not solve concurrency only with application-level checks."
--
-- These constraints are the backstop. If a future code path decrements a
-- balance without taking the lock, the write fails loudly instead of quietly
-- creating coins that were never purchased.
--
-- Written as NOT VALID + VALIDATE so the ACCESS EXCLUSIVE lock is held only
-- briefly: adding a validated CHECK scans the whole table under that lock,
-- while VALIDATE CONSTRAINT takes a weaker SHARE UPDATE EXCLUSIVE lock and
-- lets concurrent reads and writes continue.

-- Seller inventory: available and reserved balances are quantities of coins the
-- seller actually holds, so neither can be negative.
ALTER TABLE "coin_seller_inventories"
  ADD CONSTRAINT "coin_seller_inventories_available_balance_non_negative"
  CHECK ("availableBalance" >= 0) NOT VALID;

ALTER TABLE "coin_seller_inventories"
  VALIDATE CONSTRAINT "coin_seller_inventories_available_balance_non_negative";

ALTER TABLE "coin_seller_inventories"
  ADD CONSTRAINT "coin_seller_inventories_reserved_balance_non_negative"
  CHECK ("reservedBalance" >= 0) NOT VALID;

ALTER TABLE "coin_seller_inventories"
  VALIDATE CONSTRAINT "coin_seller_inventories_reserved_balance_non_negative";

-- Treasury: seller inventory is now sourced from treasuryBalance (PRD §17), so
-- this is the constraint that makes "inventory never appears from nowhere"
-- enforceable rather than merely intended.
ALTER TABLE "treasury_reserves"
  ADD CONSTRAINT "treasury_reserves_treasury_balance_non_negative"
  CHECK ("treasuryBalance" >= 0) NOT VALID;

ALTER TABLE "treasury_reserves"
  VALIDATE CONSTRAINT "treasury_reserves_treasury_balance_non_negative";
