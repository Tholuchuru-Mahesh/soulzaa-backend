-- Wealth Level notification support: new NotificationType values (the new
-- system's real lifecycle — level up, downgrade, monthly reset, reward
-- available/claimed) and a dedicated per-user opt-out column, additive
-- alongside (not replacing) the deprecated legacy VIP_* types/vipEvents flag.

ALTER TYPE "NotificationType" ADD VALUE 'WEALTH_LEVEL_UP';
ALTER TYPE "NotificationType" ADD VALUE 'WEALTH_LEVEL_DOWNGRADED';
ALTER TYPE "NotificationType" ADD VALUE 'WEALTH_MONTHLY_RESET';
ALTER TYPE "NotificationType" ADD VALUE 'WEALTH_REWARD_AVAILABLE';
ALTER TYPE "NotificationType" ADD VALUE 'WEALTH_REWARD_CLAIMED';

-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN "wealthEvents" BOOLEAN NOT NULL DEFAULT true;
