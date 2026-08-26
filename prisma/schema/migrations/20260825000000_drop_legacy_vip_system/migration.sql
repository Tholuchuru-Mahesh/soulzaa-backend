-- Drop the legacy VIP system, fully superseded by the Wealth Level system
-- (wealth_levels, wealth_user_progress, wealth_exp_ledger, etc.).
--
-- Safety verification performed immediately before this migration:
--   - Live row counts: vip_memberships/vip_subscriptions/vip_benefits/vip_rewards/
--     vip_histories/vip_audits/vip_statistics/vip_configurations = 0 rows each.
--     vip_tiers = 10 rows, confirmed to be exclusively the legacy VipTierService
--     seed set ("VIP 1".."VIP 10", badge_vip_N/frame_vip_N naming, single seeding
--     burst on 2026-08-10) — no relation to the new Wealth Level schema.
--   - user_statistics."vipLevel" > 0 = 0 rows.
--   - Zero live foreign-key constraints reference any vip_* table in either direction.
--   - Zero application/API/scheduler/Super Admin/Flutter/wallet references remain
--     (legacy src/modules/vip module, RBAC permissions, and Super Admin endpoints
--     already removed in prior commits).

-- AlterTable
ALTER TABLE "user_statistics" DROP COLUMN "vipLevel";

-- DropTable
DROP TABLE "vip_audits";

-- DropTable
DROP TABLE "vip_benefits";

-- DropTable
DROP TABLE "vip_configurations";

-- DropTable
DROP TABLE "vip_histories";

-- DropTable
DROP TABLE "vip_memberships";

-- DropTable
DROP TABLE "vip_rewards";

-- DropTable
DROP TABLE "vip_statistics";

-- DropTable
DROP TABLE "vip_subscriptions";

-- DropTable
DROP TABLE "vip_tiers";
