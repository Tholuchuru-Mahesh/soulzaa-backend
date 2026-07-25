-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('GOOGLE_PLAY', 'APPLE_IAP', 'RAZORPAY', 'STRIPE', 'MOCK_GATEWAY');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('CREATED', 'PENDING_PAYMENT', 'VERIFICATION_PENDING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SettingValueType" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'JSON');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('GLOBAL', 'COUNTRY', 'STATE', 'REGION');

-- CreateEnum
CREATE TYPE "WalletType" AS ENUM ('USER_WALLET', 'HOST_WALLET', 'AGENCY_WALLET', 'COIN_SELLER_WALLET', 'TREASURY_WALLET', 'SYSTEM_WALLET', 'ESCROW_WALLET', 'GAME_ESCROW_WALLET');

-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'LOCKED', 'FROZEN', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('HELD', 'RELEASED', 'CONSUMED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REVERSED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('PURCHASE', 'GIFT', 'REWARD', 'BONUS', 'TREASURE', 'WITHDRAWAL', 'DEPOSIT', 'REFUND', 'SETTLEMENT', 'PENALTY', 'ADJUSTMENT', 'TRANSFER', 'GAME_ENTRY', 'GAME_REWARD');

-- AlterEnum
BEGIN;
CREATE TYPE "GiftCategory_new" AS ENUM ('CLASSIC', 'LUXURY', 'FESTIVAL', 'VIP', 'PREMIUM', 'SPECIAL_EVENT', 'ANIMATED', 'LIMITED_EDITION');
ALTER TABLE "gifts" ALTER COLUMN "category" TYPE "GiftCategory_new" USING ("category"::text::"GiftCategory_new");
ALTER TYPE "GiftCategory" RENAME TO "GiftCategory_old";
ALTER TYPE "GiftCategory_new" RENAME TO "GiftCategory";
DROP TYPE "public"."GiftCategory_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "PlatformRole_new" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'COUNTRY_MANAGER', 'OFFICIAL', 'MODERATOR', 'BUSINESS_DEVELOPMENT', 'AGENCY', 'COIN_SELLER', 'HOST', 'USER');
ALTER TABLE "public"."users" ALTER COLUMN "roles" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "roles" TYPE "PlatformRole_new"[] USING ("roles"::text::"PlatformRole_new"[]);
ALTER TYPE "PlatformRole" RENAME TO "PlatformRole_old";
ALTER TYPE "PlatformRole_new" RENAME TO "PlatformRole";
DROP TYPE "public"."PlatformRole_old";
ALTER TABLE "users" ALTER COLUMN "roles" SET DEFAULT ARRAY['USER']::"PlatformRole"[];
COMMIT;

-- DropIndex
DROP INDEX "audio_rooms_ownerId_idx";

-- DropIndex
DROP INDEX "families_leaderId_idx";

-- DropIndex
DROP INDEX "family_members_familyId_idx";

-- DropIndex
DROP INDEX "video_room_messages_content_trgm_idx";

-- DropIndex
DROP INDEX "wallet_transactions_reason_idx";

-- DropIndex
DROP INDEX "wallet_transactions_userId_createdAt_idx";

-- AlterTable
ALTER TABLE "audio_rooms" ALTER COLUMN "status" SET DEFAULT 'OFFLINE';

-- AlterTable
ALTER TABLE "casino_rounds" ADD COLUMN     "roundNumber" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "families" DROP COLUMN "autoAccept",
DROP COLUMN "deletedAt",
DROP COLUMN "leaderId",
DROP COLUMN "logoKey",
ADD COLUMN     "announcement" TEXT,
ADD COLUMN     "badge" TEXT,
ADD COLUMN     "banner" TEXT,
ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'GENERAL',
ADD COLUMN     "coins" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "country" TEXT NOT NULL DEFAULT 'GLOBAL',
ADD COLUMN     "founderId" UUID NOT NULL,
ADD COLUMN     "isVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "logo" TEXT,
ADD COLUMN     "privacy" TEXT NOT NULL DEFAULT 'PUBLIC',
ADD COLUMN     "reputation" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "score" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "tag" TEXT NOT NULL,
ADD COLUMN     "welcomeMessage" TEXT;

-- AlterTable
ALTER TABLE "family_join_requests" ADD COLUMN     "reviewerId" UUID,
DROP COLUMN "status",
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "family_members" DROP COLUMN "contributionPoints",
ADD COLUMN     "coinContribution" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "expContribution" BIGINT NOT NULL DEFAULT 0,
DROP COLUMN "role",
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'MEMBER';

-- AlterTable
ALTER TABLE "game_lobby_members" ADD COLUMN     "isReady" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "gift_transactions" ALTER COLUMN "giftType" SET DEFAULT 'STATIC',
ALTER COLUMN "contextType" SET DEFAULT 'AUDIO_ROOM';

-- AlterTable
ALTER TABLE "gifts" ADD COLUMN     "activeFrom" TIMESTAMP(3),
ADD COLUMN     "activeUntil" TIMESTAMP(3),
ADD COLUMN     "code" TEXT NOT NULL,
ADD COLUMN     "countryRestriction" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "description" TEXT,
ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "lottieUrl" TEXT,
ADD COLUMN     "mp4Url" TEXT,
ADD COLUMN     "platformRestriction" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "popularity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "svgaUrl" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "category" SET DEFAULT 'CLASSIC',
ALTER COLUMN "type" SET DEFAULT 'STATIC';

-- AlterTable
ALTER TABLE "video_room_invitations" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT;

-- AlterTable
ALTER TABLE "video_room_seat_requests" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastError" TEXT;

-- AlterTable
ALTER TABLE "video_room_settings" ADD COLUMN     "seatApprovalRequired" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "wallet_transactions" DROP COLUMN "balanceAfter",
DROP COLUMN "balanceBefore",
DROP COLUMN "reason",
DROP COLUMN "type",
DROP COLUMN "userId",
ADD COLUMN     "destinationWalletId" UUID,
ADD COLUMN     "sourceWalletId" UUID,
ADD COLUMN     "status" "TransactionStatus" NOT NULL DEFAULT 'COMPLETED',
ADD COLUMN     "transactionType" "TransactionType" NOT NULL,
ALTER COLUMN "currency" SET DEFAULT 'GOLD';

-- AlterTable
ALTER TABLE "wallets" DROP CONSTRAINT "wallets_pkey",
ADD COLUMN     "availableBalance" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "id" UUID NOT NULL,
ADD COLUMN     "lockedBalance" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "pendingBalance" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "reservedBalance" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "type" "WalletType" NOT NULL DEFAULT 'USER_WALLET',
ADD CONSTRAINT "wallets_pkey" PRIMARY KEY ("id");

-- DropTable
DROP TABLE "exp_logs";

-- DropTable
DROP TABLE "family_logs";

-- DropTable
DROP TABLE "level_configs";

-- DropTable
DROP TABLE "room_exp";

-- DropTable
DROP TABLE "room_exp_logs";

-- DropTable
DROP TABLE "room_level_configs";

-- DropTable
DROP TABLE "user_exp";

-- DropTable
DROP TABLE "vip_configs";

-- DropTable
DROP TABLE "vip_logs";

-- DropTable
DROP TABLE "vip_recharge_logs";

-- DropTable
DROP TABLE "vip_status";

-- DropEnum
DROP TYPE "ExpSource";

-- DropEnum
DROP TYPE "FamilyRequestStatus";

-- DropEnum
DROP TYPE "FamilyRole";

-- DropEnum
DROP TYPE "VipLevel";

-- CreateTable
CREATE TABLE "achievement_definitions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "badgeCode" TEXT,
    "icon" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "visibility" TEXT NOT NULL DEFAULT 'PUBLIC',
    "requiredProgress" INTEGER NOT NULL DEFAULT 1,
    "unlockRule" JSONB,
    "rewardDefinition" JSONB,
    "repeatable" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "achievement_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "achievement_progresses" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "achievementId" UUID NOT NULL,
    "currentProgress" INTEGER NOT NULL DEFAULT 0,
    "requiredProgress" INTEGER NOT NULL DEFAULT 1,
    "percentComplete" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "lastEventCode" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "achievement_progresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_achievements" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "achievementId" UUID NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "rewardClaimed" BOOLEAN NOT NULL DEFAULT false,
    "grantedBy" UUID,
    "unlockIteration" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "user_achievements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "badge_definitions" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tier" TEXT NOT NULL DEFAULT 'BRONZE',
    "badgeType" TEXT NOT NULL DEFAULT 'STANDARD',
    "iconUrl" TEXT,
    "animationUrl" TEXT,
    "rarity" TEXT NOT NULL DEFAULT 'COMMON',
    "season" TEXT,
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "badge_definitions_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "badge_inventories" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "badgeCode" TEXT NOT NULL,
    "equipped" BOOLEAN NOT NULL DEFAULT false,
    "equippedAt" TIMESTAMP(3),
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT,
    "sourceRefId" TEXT,

    CONSTRAINT "badge_inventories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "achievement_histories" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "achievementId" UUID NOT NULL,
    "eventCode" TEXT NOT NULL,
    "progressBefore" INTEGER NOT NULL DEFAULT 0,
    "progressAfter" INTEGER NOT NULL DEFAULT 0,
    "unlocked" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "achievement_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "achievement_statistics" (
    "id" UUID NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'DAILY',
    "dateKey" TEXT NOT NULL,
    "totalUnlocks" INTEGER NOT NULL DEFAULT 0,
    "uniqueUsersUnlocked" INTEGER NOT NULL DEFAULT 0,
    "totalBadgesAwarded" INTEGER NOT NULL DEFAULT 0,
    "totalRewardsClaimed" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "achievement_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "achievement_audits" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "achievement_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "achievement_configurations" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "achievement_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agency_relationships" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agency_settlements" (
    "id" UUID NOT NULL,
    "revenueDistributionId" UUID NOT NULL,
    "giftTxnId" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "hostEarningsCoins" BIGINT NOT NULL,
    "commissionPercentage" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "agencyCommissionCoins" BIGINT NOT NULL,
    "walletTxnId" UUID,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agency_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agency_commissions" (
    "id" UUID NOT NULL,
    "settlementId" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agency_commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agency_histories" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'HOST_REVENUE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agency_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agency_audits" (
    "id" UUID NOT NULL,
    "agencyId" UUID,
    "hostId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agency_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agency_statistics" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'DAILY',
    "dateKey" TEXT NOT NULL,
    "totalCommissionCoins" BIGINT NOT NULL DEFAULT 0,
    "settlementCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agency_configurations" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_reports" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "parameters" JSONB,
    "data" JSONB,
    "generatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_snapshots" (
    "id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "metricValue" DOUBLE PRECISION NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_metrics" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analytics_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_dashboards" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "layout" JSONB,
    "metrics" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analytics_dashboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_statistics" (
    "id" UUID NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'DAILY',
    "dateKey" TEXT NOT NULL,
    "metricType" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "amount" DECIMAL(20,2) NOT NULL DEFAULT 0.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analytics_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_audits" (
    "id" UUID NOT NULL,
    "reportId" UUID,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_configurations" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analytics_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_exports" (
    "id" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "format" TEXT NOT NULL,
    "url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_seller_relationships" (
    "id" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_seller_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_seller_settlements" (
    "id" UUID NOT NULL,
    "purchaseTxnId" TEXT NOT NULL,
    "sellerId" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "purchaseAmountCoins" BIGINT NOT NULL,
    "commissionPercentage" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "sellerCommissionCoins" BIGINT NOT NULL,
    "walletTxnId" UUID,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coin_seller_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_seller_commissions" (
    "id" UUID NOT NULL,
    "settlementId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coin_seller_commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_seller_histories" (
    "id" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'COIN_PURCHASE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coin_seller_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_seller_audits" (
    "id" UUID NOT NULL,
    "sellerId" UUID,
    "buyerId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coin_seller_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_seller_statistics" (
    "id" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'DAILY',
    "dateKey" TEXT NOT NULL,
    "totalCommissionCoins" BIGINT NOT NULL DEFAULT 0,
    "settlementCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_seller_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_seller_configurations" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_seller_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_widgets" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "visibleToRoles" JSONB,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_widgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_layouts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "gridConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_alerts" (
    "id" UUID NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'WARNING',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_configurations" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_audits" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_statistics" (
    "id" UUID NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'DAILY',
    "dateKey" TEXT NOT NULL,
    "widgetRefreshes" INTEGER NOT NULL DEFAULT 0,
    "alertsRaised" INTEGER NOT NULL DEFAULT 0,
    "exportsCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_definitions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "banner" TEXT,
    "thumbnail" TEXT,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "regStartTime" TIMESTAMP(3),
    "regEndTime" TIMESTAMP(3),
    "participationRules" JSONB,
    "eligibilityRules" JSONB,
    "rewardDefinition" JSONB,
    "maxParticipants" INTEGER NOT NULL DEFAULT 1000,
    "visibility" TEXT NOT NULL DEFAULT 'PUBLIC',
    "country" TEXT,
    "region" TEXT,
    "season" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_registrations" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'REGISTERED',

    CONSTRAINT "event_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_participants" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PARTICIPATING',
    "score" BIGINT NOT NULL DEFAULT 0,
    "metadata" JSONB,

    CONSTRAINT "event_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_rewards" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "rewardDefinition" JSONB NOT NULL,
    "dispatched" BOOLEAN NOT NULL DEFAULT false,
    "dispatchedAt" TIMESTAMP(3),

    CONSTRAINT "event_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_histories" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "userId" UUID,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_statistics" (
    "id" UUID NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'DAILY',
    "dateKey" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "activeEvents" INTEGER NOT NULL DEFAULT 0,
    "completedEvents" INTEGER NOT NULL DEFAULT 0,
    "totalRegistrations" INTEGER NOT NULL DEFAULT 0,
    "totalParticipants" INTEGER NOT NULL DEFAULT 0,
    "totalRewardsDispatched" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_audits" (
    "id" UUID NOT NULL,
    "eventId" UUID,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_configurations" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranking_definitions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "entityType" TEXT NOT NULL DEFAULT 'USER',
    "timeWindow" TEXT NOT NULL DEFAULT 'DAILY',
    "scoreFormula" JSONB,
    "visibility" TEXT NOT NULL DEFAULT 'PUBLIC',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "maxEntries" INTEGER NOT NULL DEFAULT 1000,
    "country" TEXT,
    "region" TEXT,
    "season" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ranking_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranking_entries" (
    "id" UUID NOT NULL,
    "rankingId" UUID NOT NULL,
    "entityId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "score" BIGINT NOT NULL DEFAULT 0,
    "rank" INTEGER NOT NULL,
    "previousRank" INTEGER,
    "rankDelta" INTEGER NOT NULL DEFAULT 0,
    "country" TEXT,
    "region" TEXT,
    "period" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "season" TEXT,
    "metadata" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ranking_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprise_ranking_snapshots" (
    "id" UUID NOT NULL,
    "rankingId" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "previousRank" INTEGER,
    "score" BIGINT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enterprise_ranking_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranking_histories" (
    "id" UUID NOT NULL,
    "rankingId" UUID NOT NULL,
    "entityId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "eventCode" TEXT NOT NULL,
    "scoreDelta" BIGINT NOT NULL,
    "scoreBefore" BIGINT NOT NULL,
    "scoreAfter" BIGINT NOT NULL,
    "rankBefore" INTEGER,
    "rankAfter" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ranking_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranking_statistics" (
    "id" UUID NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'DAILY',
    "dateKey" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "totalEntries" INTEGER NOT NULL DEFAULT 0,
    "totalScoreAwarded" BIGINT NOT NULL DEFAULT 0,
    "topEntityId" TEXT,
    "topEntityScore" BIGINT,
    "promotions" INTEGER NOT NULL DEFAULT 0,
    "demotions" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ranking_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranking_audits" (
    "id" UUID NOT NULL,
    "entityId" UUID,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ranking_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranking_configurations" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ranking_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_levels" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "currentLevel" INTEGER NOT NULL DEFAULT 1,
    "lifetimeExp" BIGINT NOT NULL DEFAULT 0,
    "dailyExp" BIGINT NOT NULL DEFAULT 0,
    "weeklyExp" BIGINT NOT NULL DEFAULT 0,
    "monthlyExp" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "level_definitions" (
    "id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "title" TEXT,
    "requiredExp" BIGINT NOT NULL DEFAULT 0,
    "icon" TEXT,
    "badgeUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "level_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experience_sources" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseExp" INTEGER NOT NULL DEFAULT 10,
    "dailyCap" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "experience_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experience_histories" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "sourceCode" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "previousLevel" INTEGER NOT NULL,
    "newLevel" INTEGER NOT NULL,
    "totalExpAfter" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experience_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "level_statistics" (
    "id" UUID NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'DAILY',
    "dateKey" TEXT NOT NULL,
    "totalExpGranted" BIGINT NOT NULL DEFAULT 0,
    "levelUpsCount" INTEGER NOT NULL DEFAULT 0,
    "activeUsersCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "level_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "level_audits" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "level_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "level_configurations" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "level_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "family_roles" (
    "id" UUID NOT NULL,
    "familyId" UUID,
    "name" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 1,
    "permissions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "family_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "family_invitations" (
    "id" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "inviterId" UUID NOT NULL,
    "inviteeId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "family_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "family_bans" (
    "id" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "bannedById" UUID NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "family_bans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "family_histories" (
    "id" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "userId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "family_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "family_audits" (
    "id" UUID NOT NULL,
    "familyId" UUID,
    "userId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "family_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "family_statistics" (
    "id" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'DAILY',
    "dateKey" TEXT NOT NULL,
    "activeMembersCount" INTEGER NOT NULL DEFAULT 0,
    "expGained" BIGINT NOT NULL DEFAULT 0,
    "coinsContributed" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "family_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "family_configurations" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "family_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_categories" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "iconUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gift_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_inventories" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "giftId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gift_inventories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_availabilities" (
    "id" UUID NOT NULL,
    "giftId" UUID NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'GLOBAL',
    "platform" TEXT NOT NULL DEFAULT 'ALL',
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "gift_availabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_audits" (
    "id" UUID NOT NULL,
    "giftId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprise_notifications" (
    "id" UUID NOT NULL,
    "recipientId" UUID,
    "type" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "title" TEXT,
    "body" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprise_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "titleTemplate" TEXT NOT NULL,
    "bodyTemplate" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "variables" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprise_notification_preferences" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprise_notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_inboxes" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_inboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_histories" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "recipientId" UUID,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_statistics" (
    "id" UUID NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'DAILY',
    "dateKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "readCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_audits" (
    "id" UUID NOT NULL,
    "notificationId" UUID,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_configurations" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_packages" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "coins" BIGINT NOT NULL,
    "bonusCoins" BIGINT NOT NULL DEFAULT 0,
    "priceAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "country" TEXT DEFAULT 'GLOBAL',
    "platform" TEXT DEFAULT 'ALL',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "coinsAmount" BIGINT NOT NULL,
    "bonusCoinsAmount" BIGINT NOT NULL DEFAULT 0,
    "totalCoins" BIGINT NOT NULL,
    "priceAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'CREATED',
    "providerTxnRef" TEXT,
    "walletTransactionId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "metadata" JSONB,
    "expiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_receipts" (
    "id" UUID NOT NULL,
    "purchaseOrderId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "receiptData" TEXT NOT NULL,
    "signature" TEXT,
    "providerTxnId" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "verificationResult" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_audits" (
    "id" UUID NOT NULL,
    "purchaseOrderId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "value" TEXT NOT NULL,
    "valueType" "SettingValueType" NOT NULL DEFAULT 'STRING',
    "defaultValue" TEXT,
    "description" TEXT,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "isReadOnly" BOOLEAN NOT NULL DEFAULT false,
    "isFeatureFlag" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setting_histories" (
    "id" UUID NOT NULL,
    "settingId" UUID NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT NOT NULL,
    "changeReason" TEXT,
    "changedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "setting_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'SYSTEM',
    "displayName" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "assignedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_hierarchies" (
    "id" UUID NOT NULL,
    "parentRoleId" UUID NOT NULL,
    "childRoleId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_hierarchies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "countries" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "countries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "states" (
    "id" UUID NOT NULL,
    "countryId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regions" (
    "id" UUID NOT NULL,
    "stateId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "regions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_scopes" (
    "id" UUID NOT NULL,
    "userRoleId" UUID NOT NULL,
    "scopeType" "ScopeType" NOT NULL,
    "countryId" UUID,
    "stateId" UUID,
    "regionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "actorRole" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_campaigns" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "qualificationRules" JSONB,
    "rewardDefinition" JSONB,
    "maxUses" INTEGER NOT NULL DEFAULT 10000,
    "usesCount" INTEGER NOT NULL DEFAULT 0,
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_codes" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "referrerId" UUID NOT NULL,
    "campaignId" UUID,
    "inviteLink" TEXT,
    "qrCodeUrl" TEXT,
    "maxUses" INTEGER NOT NULL DEFAULT 100,
    "usesCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_relationships" (
    "id" UUID NOT NULL,
    "referralCodeId" UUID,
    "referrerId" UUID NOT NULL,
    "refereeId" UUID NOT NULL,
    "campaignId" UUID,
    "referralType" TEXT NOT NULL DEFAULT 'USER',
    "status" TEXT NOT NULL DEFAULT 'REGISTERED',
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qualifiedAt" TIMESTAMP(3),
    "rewardedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_qualifications" (
    "id" UUID NOT NULL,
    "relationshipId" UUID NOT NULL,
    "ruleName" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "reasons" JSONB,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_qualifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_rewards" (
    "id" UUID NOT NULL,
    "relationshipId" UUID NOT NULL,
    "referrerId" UUID NOT NULL,
    "refereeId" UUID NOT NULL,
    "rewardDefinition" JSONB NOT NULL,
    "dispatched" BOOLEAN NOT NULL DEFAULT false,
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_histories" (
    "id" UUID NOT NULL,
    "relationshipId" UUID,
    "referrerId" UUID NOT NULL,
    "refereeId" UUID,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_statistics" (
    "id" UUID NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'DAILY',
    "dateKey" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "codesCreated" INTEGER NOT NULL DEFAULT 0,
    "registeredCount" INTEGER NOT NULL DEFAULT 0,
    "qualifiedCount" INTEGER NOT NULL DEFAULT 0,
    "rewardedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_audits" (
    "id" UUID NOT NULL,
    "relationshipId" UUID,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_configurations" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_distributions" (
    "id" UUID NOT NULL,
    "giftTxnId" UUID NOT NULL,
    "contextType" TEXT NOT NULL DEFAULT 'AUDIO_ROOM',
    "contextId" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "totalCoinValue" BIGINT NOT NULL,
    "hostPercentage" DOUBLE PRECISION NOT NULL DEFAULT 50.0,
    "platformPercentage" DOUBLE PRECISION NOT NULL DEFAULT 50.0,
    "hostEarningsCoins" BIGINT NOT NULL,
    "platformEarningsCoins" BIGINT NOT NULL,
    "walletTxnId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_distributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "host_earnings" (
    "id" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "totalEarnedCoins" BIGINT NOT NULL DEFAULT 0,
    "totalGiftCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "host_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_histories" (
    "id" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "contextId" UUID,
    "amount" BIGINT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'GIFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_audits" (
    "id" UUID NOT NULL,
    "hostId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_statistics" (
    "id" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "roomId" UUID,
    "period" TEXT NOT NULL DEFAULT 'DAILY',
    "dateKey" TEXT NOT NULL,
    "totalCoins" BIGINT NOT NULL DEFAULT 0,
    "giftCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "revenue_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_configurations" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "revenue_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mission_definitions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "requiredTaskCount" INTEGER NOT NULL DEFAULT 1,
    "rewardDefinition" JSONB,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mission_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_definitions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "missionId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "requiredProgress" INTEGER NOT NULL DEFAULT 1,
    "progressRules" JSONB,
    "completionRules" JSONB,
    "rewardDefinition" JSONB,
    "visibility" TEXT NOT NULL DEFAULT 'PUBLIC',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "difficulty" TEXT NOT NULL DEFAULT 'EASY',
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),
    "repeatable" BOOLEAN NOT NULL DEFAULT false,
    "resetPolicy" TEXT NOT NULL DEFAULT 'DAILY',
    "maxCompletions" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_progress" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "currentProgress" INTEGER NOT NULL DEFAULT 0,
    "requiredProgress" INTEGER NOT NULL,
    "percentComplete" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "completionCount" INTEGER NOT NULL DEFAULT 0,
    "periodKey" TEXT NOT NULL DEFAULT 'alltime',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mission_progress" (
    "id" UUID NOT NULL,
    "missionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "completedTaskCount" INTEGER NOT NULL DEFAULT 0,
    "requiredTaskCount" INTEGER NOT NULL,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "rewardClaimed" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mission_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_rewards" (
    "id" UUID NOT NULL,
    "taskId" UUID,
    "missionId" UUID,
    "userId" UUID NOT NULL,
    "rewardDefinition" JSONB NOT NULL,
    "claimed" BOOLEAN NOT NULL DEFAULT false,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_histories" (
    "id" UUID NOT NULL,
    "taskId" UUID,
    "missionId" UUID,
    "userId" UUID NOT NULL,
    "eventCode" TEXT NOT NULL,
    "progressBefore" INTEGER NOT NULL,
    "progressAfter" INTEGER NOT NULL,
    "completed" BOOLEAN NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_statistics" (
    "id" UUID NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'DAILY',
    "dateKey" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "activeTasks" INTEGER NOT NULL DEFAULT 0,
    "completedTasks" INTEGER NOT NULL DEFAULT 0,
    "completedMissions" INTEGER NOT NULL DEFAULT 0,
    "rewardsDispatched" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_audits" (
    "id" UUID NOT NULL,
    "taskId" UUID,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_configurations" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasure_audits" (
    "id" UUID NOT NULL,
    "roomId" UUID,
    "boxId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treasure_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_reserves" (
    "id" UUID NOT NULL,
    "maxSupply" BIGINT NOT NULL DEFAULT 1000000000000,
    "circulatingSupply" BIGINT NOT NULL DEFAULT 0,
    "reservedSupply" BIGINT NOT NULL DEFAULT 0,
    "treasuryBalance" BIGINT NOT NULL DEFAULT 0,
    "isFrozen" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "treasury_reserves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_policies" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'WALLET_LIMITS',
    "value" BIGINT NOT NULL,
    "minLimit" BIGINT,
    "maxLimit" BIGINT,
    "description" TEXT,
    "isEditable" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_logs" (
    "id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "amount" BIGINT,
    "previousValue" TEXT,
    "newValue" TEXT,
    "reason" TEXT,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treasury_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vip_tiers" (
    "id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 1,
    "requiredExp" BIGINT NOT NULL DEFAULT 0,
    "requiredSpending" BIGINT NOT NULL DEFAULT 0,
    "subscriptionType" TEXT NOT NULL DEFAULT 'MONTHLY',
    "durationDays" INTEGER NOT NULL DEFAULT 30,
    "price" BIGINT NOT NULL DEFAULT 0,
    "badge" TEXT,
    "frame" TEXT,
    "entranceEffect" TEXT,
    "chatBubble" TEXT,
    "nameColor" TEXT,
    "profileDecoration" TEXT,
    "seatDecoration" TEXT,
    "giftDiscount" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "storeDiscount" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "dailyRewards" JSONB NOT NULL DEFAULT '[]',
    "weeklyRewards" JSONB NOT NULL DEFAULT '[]',
    "monthlyRewards" JSONB NOT NULL DEFAULT '[]',
    "maxRooms" INTEGER NOT NULL DEFAULT 1,
    "priorityMatching" BOOLEAN NOT NULL DEFAULT false,
    "exclusiveGifts" JSONB NOT NULL DEFAULT '[]',
    "exclusiveEvents" JSONB NOT NULL DEFAULT '[]',
    "visibility" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vip_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vip_memberships" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tierId" UUID NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "autoRenew" BOOLEAN NOT NULL DEFAULT false,
    "expGained" BIGINT NOT NULL DEFAULT 0,
    "totalSpent" BIGINT NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastClaimedDailyAt" TIMESTAMP(3),
    "lastClaimedWeeklyAt" TIMESTAMP(3),
    "lastClaimedMonthlyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vip_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vip_subscriptions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tierId" UUID NOT NULL,
    "pricePaid" BIGINT NOT NULL DEFAULT 0,
    "action" TEXT NOT NULL,
    "gifterUserId" UUID,
    "durationDays" INTEGER NOT NULL DEFAULT 30,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vip_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vip_benefits" (
    "id" UUID NOT NULL,
    "tierId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vip_benefits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vip_rewards" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "rewardType" TEXT NOT NULL,
    "rewardData" JSONB NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vip_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vip_histories" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vip_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vip_audits" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vip_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vip_statistics" (
    "id" UUID NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'DAILY',
    "dateKey" TEXT NOT NULL,
    "purchasesCount" INTEGER NOT NULL DEFAULT 0,
    "activeVipCount" INTEGER NOT NULL DEFAULT 0,
    "expiredCount" INTEGER NOT NULL DEFAULT 0,
    "renewalsCount" INTEGER NOT NULL DEFAULT 0,
    "upgradesCount" INTEGER NOT NULL DEFAULT 0,
    "totalRevenue" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vip_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vip_configurations" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vip_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "type" "WalletEntryType" NOT NULL,
    "currency" "WalletCurrency" NOT NULL,
    "reason" "WalletTxnReason" NOT NULL DEFAULT 'SYSTEM_TRANSFER',
    "amount" BIGINT NOT NULL,
    "balanceBefore" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "referenceType" TEXT,
    "referenceId" UUID,
    "description" TEXT,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_reservations" (
    "id" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "currency" "WalletCurrency" NOT NULL DEFAULT 'GOLD',
    "amount" BIGINT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'HELD',
    "referenceType" TEXT,
    "referenceId" UUID,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_audits" (
    "id" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_requests" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "amountCoins" BIGINT NOT NULL,
    "processingFeeCoins" BIGINT NOT NULL DEFAULT 0,
    "netPayoutAmountCoins" BIGINT NOT NULL,
    "payoutMethod" TEXT NOT NULL DEFAULT 'BANK_TRANSFER',
    "payoutDetails" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "holdTxnId" UUID,
    "payoutTxnId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_reviews" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "reviewerId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_failures" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "errorCode" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_failures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_histories" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_audits" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "requestId" UUID,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_statistics" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'DAILY',
    "dateKey" TEXT NOT NULL,
    "totalRequestedCoins" BIGINT NOT NULL DEFAULT 0,
    "totalCompletedCoins" BIGINT NOT NULL DEFAULT 0,
    "totalRejectedCoins" BIGINT NOT NULL DEFAULT 0,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_configurations" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "achievement_definitions_code_key" ON "achievement_definitions"("code");

-- CreateIndex
CREATE INDEX "achievement_definitions_category_idx" ON "achievement_definitions"("category");

-- CreateIndex
CREATE INDEX "achievement_definitions_status_idx" ON "achievement_definitions"("status");

-- CreateIndex
CREATE INDEX "achievement_definitions_visibility_idx" ON "achievement_definitions"("visibility");

-- CreateIndex
CREATE INDEX "achievement_progresses_userId_idx" ON "achievement_progresses"("userId");

-- CreateIndex
CREATE INDEX "achievement_progresses_achievementId_idx" ON "achievement_progresses"("achievementId");

-- CreateIndex
CREATE INDEX "achievement_progresses_isCompleted_idx" ON "achievement_progresses"("isCompleted");

-- CreateIndex
CREATE UNIQUE INDEX "achievement_progresses_userId_achievementId_key" ON "achievement_progresses"("userId", "achievementId");

-- CreateIndex
CREATE INDEX "user_achievements_userId_idx" ON "user_achievements"("userId");

-- CreateIndex
CREATE INDEX "user_achievements_achievementId_idx" ON "user_achievements"("achievementId");

-- CreateIndex
CREATE INDEX "user_achievements_userId_achievementId_idx" ON "user_achievements"("userId", "achievementId");

-- CreateIndex
CREATE INDEX "badge_definitions_tier_idx" ON "badge_definitions"("tier");

-- CreateIndex
CREATE INDEX "badge_definitions_badgeType_idx" ON "badge_definitions"("badgeType");

-- CreateIndex
CREATE INDEX "badge_definitions_status_idx" ON "badge_definitions"("status");

-- CreateIndex
CREATE INDEX "badge_inventories_userId_idx" ON "badge_inventories"("userId");

-- CreateIndex
CREATE INDEX "badge_inventories_userId_equipped_idx" ON "badge_inventories"("userId", "equipped");

-- CreateIndex
CREATE UNIQUE INDEX "badge_inventories_userId_badgeCode_key" ON "badge_inventories"("userId", "badgeCode");

-- CreateIndex
CREATE INDEX "achievement_histories_userId_createdAt_idx" ON "achievement_histories"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "achievement_histories_achievementId_idx" ON "achievement_histories"("achievementId");

-- CreateIndex
CREATE INDEX "achievement_histories_eventCode_idx" ON "achievement_histories"("eventCode");

-- CreateIndex
CREATE UNIQUE INDEX "achievement_statistics_period_dateKey_key" ON "achievement_statistics"("period", "dateKey");

-- CreateIndex
CREATE INDEX "achievement_audits_userId_idx" ON "achievement_audits"("userId");

-- CreateIndex
CREATE INDEX "achievement_audits_action_idx" ON "achievement_audits"("action");

-- CreateIndex
CREATE INDEX "achievement_audits_createdAt_idx" ON "achievement_audits"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "achievement_configurations_key_key" ON "achievement_configurations"("key");

-- CreateIndex
CREATE INDEX "agency_relationships_hostId_status_idx" ON "agency_relationships"("hostId", "status");

-- CreateIndex
CREATE INDEX "agency_relationships_agencyId_status_idx" ON "agency_relationships"("agencyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agency_relationships_agencyId_hostId_key" ON "agency_relationships"("agencyId", "hostId");

-- CreateIndex
CREATE UNIQUE INDEX "agency_settlements_revenueDistributionId_key" ON "agency_settlements"("revenueDistributionId");

-- CreateIndex
CREATE INDEX "agency_settlements_agencyId_createdAt_idx" ON "agency_settlements"("agencyId", "createdAt");

-- CreateIndex
CREATE INDEX "agency_settlements_hostId_createdAt_idx" ON "agency_settlements"("hostId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "agency_commissions_settlementId_key" ON "agency_commissions"("settlementId");

-- CreateIndex
CREATE INDEX "agency_commissions_agencyId_idx" ON "agency_commissions"("agencyId");

-- CreateIndex
CREATE INDEX "agency_histories_agencyId_createdAt_idx" ON "agency_histories"("agencyId", "createdAt");

-- CreateIndex
CREATE INDEX "agency_audits_agencyId_idx" ON "agency_audits"("agencyId");

-- CreateIndex
CREATE INDEX "agency_audits_createdAt_idx" ON "agency_audits"("createdAt");

-- CreateIndex
CREATE INDEX "agency_statistics_agencyId_period_idx" ON "agency_statistics"("agencyId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "agency_statistics_agencyId_period_dateKey_key" ON "agency_statistics"("agencyId", "period", "dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "agency_configurations_key_key" ON "agency_configurations"("key");

-- CreateIndex
CREATE INDEX "analytics_reports_domain_idx" ON "analytics_reports"("domain");

-- CreateIndex
CREATE INDEX "analytics_reports_createdAt_idx" ON "analytics_reports"("createdAt");

-- CreateIndex
CREATE INDEX "analytics_snapshots_domain_metricKey_timestamp_idx" ON "analytics_snapshots"("domain", "metricKey", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_metrics_key_key" ON "analytics_metrics"("key");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_statistics_period_dateKey_metricType_key" ON "analytics_statistics"("period", "dateKey", "metricType");

-- CreateIndex
CREATE INDEX "analytics_audits_reportId_idx" ON "analytics_audits"("reportId");

-- CreateIndex
CREATE INDEX "analytics_audits_action_idx" ON "analytics_audits"("action");

-- CreateIndex
CREATE INDEX "analytics_audits_createdAt_idx" ON "analytics_audits"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_configurations_key_key" ON "analytics_configurations"("key");

-- CreateIndex
CREATE INDEX "report_exports_reportId_idx" ON "report_exports"("reportId");

-- CreateIndex
CREATE INDEX "coin_seller_relationships_buyerId_status_idx" ON "coin_seller_relationships"("buyerId", "status");

-- CreateIndex
CREATE INDEX "coin_seller_relationships_sellerId_status_idx" ON "coin_seller_relationships"("sellerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "coin_seller_relationships_sellerId_buyerId_key" ON "coin_seller_relationships"("sellerId", "buyerId");

-- CreateIndex
CREATE UNIQUE INDEX "coin_seller_settlements_purchaseTxnId_key" ON "coin_seller_settlements"("purchaseTxnId");

-- CreateIndex
CREATE INDEX "coin_seller_settlements_sellerId_createdAt_idx" ON "coin_seller_settlements"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "coin_seller_settlements_buyerId_createdAt_idx" ON "coin_seller_settlements"("buyerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "coin_seller_commissions_settlementId_key" ON "coin_seller_commissions"("settlementId");

-- CreateIndex
CREATE INDEX "coin_seller_commissions_sellerId_idx" ON "coin_seller_commissions"("sellerId");

-- CreateIndex
CREATE INDEX "coin_seller_histories_sellerId_createdAt_idx" ON "coin_seller_histories"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "coin_seller_audits_sellerId_idx" ON "coin_seller_audits"("sellerId");

-- CreateIndex
CREATE INDEX "coin_seller_audits_createdAt_idx" ON "coin_seller_audits"("createdAt");

-- CreateIndex
CREATE INDEX "coin_seller_statistics_sellerId_period_idx" ON "coin_seller_statistics"("sellerId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "coin_seller_statistics_sellerId_period_dateKey_key" ON "coin_seller_statistics"("sellerId", "period", "dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "coin_seller_configurations_key_key" ON "coin_seller_configurations"("key");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_configurations_key_key" ON "dashboard_configurations"("key");

-- CreateIndex
CREATE INDEX "dashboard_audits_action_idx" ON "dashboard_audits"("action");

-- CreateIndex
CREATE INDEX "dashboard_audits_createdAt_idx" ON "dashboard_audits"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_statistics_period_dateKey_key" ON "dashboard_statistics"("period", "dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "event_definitions_code_key" ON "event_definitions"("code");

-- CreateIndex
CREATE INDEX "event_definitions_category_idx" ON "event_definitions"("category");

-- CreateIndex
CREATE INDEX "event_definitions_status_idx" ON "event_definitions"("status");

-- CreateIndex
CREATE INDEX "event_definitions_startTime_endTime_idx" ON "event_definitions"("startTime", "endTime");

-- CreateIndex
CREATE INDEX "event_definitions_country_idx" ON "event_definitions"("country");

-- CreateIndex
CREATE INDEX "event_registrations_userId_idx" ON "event_registrations"("userId");

-- CreateIndex
CREATE INDEX "event_registrations_status_idx" ON "event_registrations"("status");

-- CreateIndex
CREATE UNIQUE INDEX "event_registrations_eventId_userId_key" ON "event_registrations"("eventId", "userId");

-- CreateIndex
CREATE INDEX "event_participants_eventId_status_idx" ON "event_participants"("eventId", "status");

-- CreateIndex
CREATE INDEX "event_participants_userId_idx" ON "event_participants"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "event_participants_eventId_userId_key" ON "event_participants"("eventId", "userId");

-- CreateIndex
CREATE INDEX "event_rewards_eventId_idx" ON "event_rewards"("eventId");

-- CreateIndex
CREATE INDEX "event_rewards_userId_idx" ON "event_rewards"("userId");

-- CreateIndex
CREATE INDEX "event_rewards_dispatched_idx" ON "event_rewards"("dispatched");

-- CreateIndex
CREATE INDEX "event_histories_eventId_createdAt_idx" ON "event_histories"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "event_histories_userId_idx" ON "event_histories"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "event_statistics_period_dateKey_category_key" ON "event_statistics"("period", "dateKey", "category");

-- CreateIndex
CREATE INDEX "event_audits_eventId_idx" ON "event_audits"("eventId");

-- CreateIndex
CREATE INDEX "event_audits_action_idx" ON "event_audits"("action");

-- CreateIndex
CREATE INDEX "event_audits_createdAt_idx" ON "event_audits"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "event_configurations_key_key" ON "event_configurations"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ranking_definitions_code_key" ON "ranking_definitions"("code");

-- CreateIndex
CREATE INDEX "ranking_definitions_category_idx" ON "ranking_definitions"("category");

-- CreateIndex
CREATE INDEX "ranking_definitions_status_idx" ON "ranking_definitions"("status");

-- CreateIndex
CREATE INDEX "ranking_definitions_timeWindow_idx" ON "ranking_definitions"("timeWindow");

-- CreateIndex
CREATE INDEX "ranking_definitions_country_idx" ON "ranking_definitions"("country");

-- CreateIndex
CREATE INDEX "ranking_entries_rankingId_rank_idx" ON "ranking_entries"("rankingId", "rank");

-- CreateIndex
CREATE INDEX "ranking_entries_entityId_idx" ON "ranking_entries"("entityId");

-- CreateIndex
CREATE INDEX "ranking_entries_dateKey_idx" ON "ranking_entries"("dateKey");

-- CreateIndex
CREATE INDEX "ranking_entries_country_idx" ON "ranking_entries"("country");

-- CreateIndex
CREATE UNIQUE INDEX "ranking_entries_rankingId_entityId_dateKey_key" ON "ranking_entries"("rankingId", "entityId", "dateKey");

-- CreateIndex
CREATE INDEX "enterprise_ranking_snapshots_rankingId_dateKey_rank_idx" ON "enterprise_ranking_snapshots"("rankingId", "dateKey", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_ranking_snapshots_rankingId_period_dateKey_entit_key" ON "enterprise_ranking_snapshots"("rankingId", "period", "dateKey", "entityId");

-- CreateIndex
CREATE INDEX "ranking_histories_rankingId_entityId_createdAt_idx" ON "ranking_histories"("rankingId", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "ranking_histories_entityId_idx" ON "ranking_histories"("entityId");

-- CreateIndex
CREATE INDEX "ranking_histories_eventCode_idx" ON "ranking_histories"("eventCode");

-- CreateIndex
CREATE UNIQUE INDEX "ranking_statistics_period_dateKey_category_key" ON "ranking_statistics"("period", "dateKey", "category");

-- CreateIndex
CREATE INDEX "ranking_audits_entityId_idx" ON "ranking_audits"("entityId");

-- CreateIndex
CREATE INDEX "ranking_audits_action_idx" ON "ranking_audits"("action");

-- CreateIndex
CREATE INDEX "ranking_audits_createdAt_idx" ON "ranking_audits"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ranking_configurations_key_key" ON "ranking_configurations"("key");

-- CreateIndex
CREATE UNIQUE INDEX "user_levels_userId_key" ON "user_levels"("userId");

-- CreateIndex
CREATE INDEX "user_levels_userId_idx" ON "user_levels"("userId");

-- CreateIndex
CREATE INDEX "user_levels_currentLevel_idx" ON "user_levels"("currentLevel");

-- CreateIndex
CREATE INDEX "user_levels_lifetimeExp_idx" ON "user_levels"("lifetimeExp");

-- CreateIndex
CREATE UNIQUE INDEX "level_definitions_level_key" ON "level_definitions"("level");

-- CreateIndex
CREATE UNIQUE INDEX "experience_sources_code_key" ON "experience_sources"("code");

-- CreateIndex
CREATE UNIQUE INDEX "experience_histories_idempotencyKey_key" ON "experience_histories"("idempotencyKey");

-- CreateIndex
CREATE INDEX "experience_histories_userId_createdAt_idx" ON "experience_histories"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "experience_histories_sourceCode_idx" ON "experience_histories"("sourceCode");

-- CreateIndex
CREATE UNIQUE INDEX "level_statistics_period_dateKey_key" ON "level_statistics"("period", "dateKey");

-- CreateIndex
CREATE INDEX "level_audits_userId_idx" ON "level_audits"("userId");

-- CreateIndex
CREATE INDEX "level_audits_createdAt_idx" ON "level_audits"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "level_configurations_key_key" ON "level_configurations"("key");

-- CreateIndex
CREATE UNIQUE INDEX "family_roles_familyId_name_key" ON "family_roles"("familyId", "name");

-- CreateIndex
CREATE INDEX "family_invitations_inviteeId_status_idx" ON "family_invitations"("inviteeId", "status");

-- CreateIndex
CREATE INDEX "family_invitations_familyId_idx" ON "family_invitations"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "family_bans_familyId_userId_key" ON "family_bans"("familyId", "userId");

-- CreateIndex
CREATE INDEX "family_histories_familyId_createdAt_idx" ON "family_histories"("familyId", "createdAt");

-- CreateIndex
CREATE INDEX "family_audits_familyId_idx" ON "family_audits"("familyId");

-- CreateIndex
CREATE INDEX "family_audits_createdAt_idx" ON "family_audits"("createdAt");

-- CreateIndex
CREATE INDEX "family_statistics_familyId_period_idx" ON "family_statistics"("familyId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "family_statistics_familyId_period_dateKey_key" ON "family_statistics"("familyId", "period", "dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "family_configurations_key_key" ON "family_configurations"("key");

-- CreateIndex
CREATE UNIQUE INDEX "gift_categories_code_key" ON "gift_categories"("code");

-- CreateIndex
CREATE INDEX "gift_inventories_userId_idx" ON "gift_inventories"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "gift_inventories_userId_giftId_key" ON "gift_inventories"("userId", "giftId");

-- CreateIndex
CREATE UNIQUE INDEX "gift_availabilities_giftId_country_platform_key" ON "gift_availabilities"("giftId", "country", "platform");

-- CreateIndex
CREATE INDEX "gift_audits_giftId_idx" ON "gift_audits"("giftId");

-- CreateIndex
CREATE INDEX "gift_audits_createdAt_idx" ON "gift_audits"("createdAt");

-- CreateIndex
CREATE INDEX "enterprise_notifications_recipientId_idx" ON "enterprise_notifications"("recipientId");

-- CreateIndex
CREATE INDEX "enterprise_notifications_status_idx" ON "enterprise_notifications"("status");

-- CreateIndex
CREATE INDEX "enterprise_notifications_type_idx" ON "enterprise_notifications"("type");

-- CreateIndex
CREATE INDEX "enterprise_notifications_createdAt_idx" ON "enterprise_notifications"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_code_key" ON "notification_templates"("code");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_notification_preferences_userId_type_channel_key" ON "enterprise_notification_preferences"("userId", "type", "channel");

-- CreateIndex
CREATE INDEX "notification_inboxes_recipientId_idx" ON "notification_inboxes"("recipientId");

-- CreateIndex
CREATE INDEX "notification_inboxes_read_idx" ON "notification_inboxes"("read");

-- CreateIndex
CREATE INDEX "notification_inboxes_deleted_idx" ON "notification_inboxes"("deleted");

-- CreateIndex
CREATE INDEX "notification_histories_notificationId_idx" ON "notification_histories"("notificationId");

-- CreateIndex
CREATE INDEX "notification_histories_recipientId_idx" ON "notification_histories"("recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_statistics_period_dateKey_channel_key" ON "notification_statistics"("period", "dateKey", "channel");

-- CreateIndex
CREATE INDEX "notification_audits_notificationId_idx" ON "notification_audits"("notificationId");

-- CreateIndex
CREATE INDEX "notification_audits_action_idx" ON "notification_audits"("action");

-- CreateIndex
CREATE INDEX "notification_audits_createdAt_idx" ON "notification_audits"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_configurations_key_key" ON "notification_configurations"("key");

-- CreateIndex
CREATE UNIQUE INDEX "coin_packages_code_key" ON "coin_packages"("code");

-- CreateIndex
CREATE INDEX "coin_packages_isActive_idx" ON "coin_packages"("isActive");

-- CreateIndex
CREATE INDEX "coin_packages_platform_idx" ON "coin_packages"("platform");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_orderNumber_key" ON "purchase_orders"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_idempotencyKey_key" ON "purchase_orders"("idempotencyKey");

-- CreateIndex
CREATE INDEX "purchase_orders_userId_createdAt_idx" ON "purchase_orders"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders"("status");

-- CreateIndex
CREATE INDEX "purchase_orders_provider_providerTxnRef_idx" ON "purchase_orders"("provider", "providerTxnRef");

-- CreateIndex
CREATE UNIQUE INDEX "payment_receipts_providerTxnId_key" ON "payment_receipts"("providerTxnId");

-- CreateIndex
CREATE INDEX "payment_receipts_purchaseOrderId_idx" ON "payment_receipts"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "purchase_audits_purchaseOrderId_idx" ON "purchase_audits"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "purchase_audits_createdAt_idx" ON "purchase_audits"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "platform_settings_key_key" ON "platform_settings"("key");

-- CreateIndex
CREATE INDEX "platform_settings_category_idx" ON "platform_settings"("category");

-- CreateIndex
CREATE INDEX "platform_settings_isFeatureFlag_idx" ON "platform_settings"("isFeatureFlag");

-- CreateIndex
CREATE INDEX "setting_histories_settingId_idx" ON "setting_histories"("settingId");

-- CreateIndex
CREATE INDEX "setting_histories_createdAt_idx" ON "setting_histories"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE INDEX "permissions_module_idx" ON "permissions"("module");

-- CreateIndex
CREATE INDEX "permissions_category_idx" ON "permissions"("category");

-- CreateIndex
CREATE INDEX "role_permissions_roleId_idx" ON "role_permissions"("roleId");

-- CreateIndex
CREATE INDEX "role_permissions_permissionId_idx" ON "role_permissions"("permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_roleId_permissionId_key" ON "role_permissions"("roleId", "permissionId");

-- CreateIndex
CREATE INDEX "user_roles_userId_idx" ON "user_roles"("userId");

-- CreateIndex
CREATE INDEX "user_roles_roleId_idx" ON "user_roles"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_userId_roleId_key" ON "user_roles"("userId", "roleId");

-- CreateIndex
CREATE INDEX "role_hierarchies_parentRoleId_idx" ON "role_hierarchies"("parentRoleId");

-- CreateIndex
CREATE INDEX "role_hierarchies_childRoleId_idx" ON "role_hierarchies"("childRoleId");

-- CreateIndex
CREATE UNIQUE INDEX "role_hierarchies_parentRoleId_childRoleId_key" ON "role_hierarchies"("parentRoleId", "childRoleId");

-- CreateIndex
CREATE UNIQUE INDEX "countries_code_key" ON "countries"("code");

-- CreateIndex
CREATE INDEX "countries_isActive_idx" ON "countries"("isActive");

-- CreateIndex
CREATE INDEX "states_countryId_idx" ON "states"("countryId");

-- CreateIndex
CREATE INDEX "states_isActive_idx" ON "states"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "states_countryId_code_key" ON "states"("countryId", "code");

-- CreateIndex
CREATE INDEX "regions_stateId_idx" ON "regions"("stateId");

-- CreateIndex
CREATE INDEX "regions_isActive_idx" ON "regions"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "regions_stateId_code_key" ON "regions"("stateId", "code");

-- CreateIndex
CREATE INDEX "role_scopes_userRoleId_idx" ON "role_scopes"("userRoleId");

-- CreateIndex
CREATE INDEX "role_scopes_scopeType_idx" ON "role_scopes"("scopeType");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_idx" ON "audit_logs"("actorId");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_resource_resourceId_idx" ON "audit_logs"("resource", "resourceId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "referral_campaigns_code_key" ON "referral_campaigns"("code");

-- CreateIndex
CREATE INDEX "referral_campaigns_category_idx" ON "referral_campaigns"("category");

-- CreateIndex
CREATE INDEX "referral_campaigns_status_idx" ON "referral_campaigns"("status");

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes"("code");

-- CreateIndex
CREATE INDEX "referral_codes_referrerId_idx" ON "referral_codes"("referrerId");

-- CreateIndex
CREATE INDEX "referral_codes_campaignId_idx" ON "referral_codes"("campaignId");

-- CreateIndex
CREATE INDEX "referral_codes_status_idx" ON "referral_codes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "referral_relationships_refereeId_key" ON "referral_relationships"("refereeId");

-- CreateIndex
CREATE INDEX "referral_relationships_referrerId_idx" ON "referral_relationships"("referrerId");

-- CreateIndex
CREATE INDEX "referral_relationships_status_idx" ON "referral_relationships"("status");

-- CreateIndex
CREATE INDEX "referral_relationships_campaignId_idx" ON "referral_relationships"("campaignId");

-- CreateIndex
CREATE INDEX "referral_qualifications_relationshipId_idx" ON "referral_qualifications"("relationshipId");

-- CreateIndex
CREATE INDEX "referral_rewards_relationshipId_idx" ON "referral_rewards"("relationshipId");

-- CreateIndex
CREATE INDEX "referral_rewards_referrerId_idx" ON "referral_rewards"("referrerId");

-- CreateIndex
CREATE INDEX "referral_rewards_refereeId_idx" ON "referral_rewards"("refereeId");

-- CreateIndex
CREATE INDEX "referral_histories_referrerId_createdAt_idx" ON "referral_histories"("referrerId", "createdAt");

-- CreateIndex
CREATE INDEX "referral_histories_refereeId_idx" ON "referral_histories"("refereeId");

-- CreateIndex
CREATE UNIQUE INDEX "referral_statistics_period_dateKey_category_key" ON "referral_statistics"("period", "dateKey", "category");

-- CreateIndex
CREATE INDEX "referral_audits_relationshipId_idx" ON "referral_audits"("relationshipId");

-- CreateIndex
CREATE INDEX "referral_audits_action_idx" ON "referral_audits"("action");

-- CreateIndex
CREATE INDEX "referral_audits_createdAt_idx" ON "referral_audits"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "referral_configurations_key_key" ON "referral_configurations"("key");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_distributions_giftTxnId_key" ON "revenue_distributions"("giftTxnId");

-- CreateIndex
CREATE INDEX "revenue_distributions_hostId_createdAt_idx" ON "revenue_distributions"("hostId", "createdAt");

-- CreateIndex
CREATE INDEX "revenue_distributions_contextId_createdAt_idx" ON "revenue_distributions"("contextId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "host_earnings_hostId_key" ON "host_earnings"("hostId");

-- CreateIndex
CREATE INDEX "revenue_histories_hostId_createdAt_idx" ON "revenue_histories"("hostId", "createdAt");

-- CreateIndex
CREATE INDEX "revenue_audits_hostId_idx" ON "revenue_audits"("hostId");

-- CreateIndex
CREATE INDEX "revenue_audits_createdAt_idx" ON "revenue_audits"("createdAt");

-- CreateIndex
CREATE INDEX "revenue_statistics_hostId_period_idx" ON "revenue_statistics"("hostId", "period");

-- CreateIndex
CREATE INDEX "revenue_statistics_roomId_period_idx" ON "revenue_statistics"("roomId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_statistics_hostId_period_dateKey_key" ON "revenue_statistics"("hostId", "period", "dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_configurations_key_key" ON "revenue_configurations"("key");

-- CreateIndex
CREATE UNIQUE INDEX "mission_definitions_code_key" ON "mission_definitions"("code");

-- CreateIndex
CREATE INDEX "mission_definitions_category_idx" ON "mission_definitions"("category");

-- CreateIndex
CREATE INDEX "mission_definitions_status_idx" ON "mission_definitions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "task_definitions_code_key" ON "task_definitions"("code");

-- CreateIndex
CREATE INDEX "task_definitions_category_idx" ON "task_definitions"("category");

-- CreateIndex
CREATE INDEX "task_definitions_status_idx" ON "task_definitions"("status");

-- CreateIndex
CREATE INDEX "task_definitions_missionId_idx" ON "task_definitions"("missionId");

-- CreateIndex
CREATE INDEX "task_definitions_resetPolicy_idx" ON "task_definitions"("resetPolicy");

-- CreateIndex
CREATE INDEX "task_progress_userId_idx" ON "task_progress"("userId");

-- CreateIndex
CREATE INDEX "task_progress_isCompleted_idx" ON "task_progress"("isCompleted");

-- CreateIndex
CREATE UNIQUE INDEX "task_progress_taskId_userId_periodKey_key" ON "task_progress"("taskId", "userId", "periodKey");

-- CreateIndex
CREATE INDEX "mission_progress_userId_idx" ON "mission_progress"("userId");

-- CreateIndex
CREATE INDEX "mission_progress_isCompleted_idx" ON "mission_progress"("isCompleted");

-- CreateIndex
CREATE UNIQUE INDEX "mission_progress_missionId_userId_key" ON "mission_progress"("missionId", "userId");

-- CreateIndex
CREATE INDEX "task_rewards_userId_idx" ON "task_rewards"("userId");

-- CreateIndex
CREATE INDEX "task_rewards_taskId_idx" ON "task_rewards"("taskId");

-- CreateIndex
CREATE INDEX "task_rewards_missionId_idx" ON "task_rewards"("missionId");

-- CreateIndex
CREATE INDEX "task_histories_userId_createdAt_idx" ON "task_histories"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "task_histories_taskId_idx" ON "task_histories"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "task_statistics_period_dateKey_category_key" ON "task_statistics"("period", "dateKey", "category");

-- CreateIndex
CREATE INDEX "task_audits_taskId_idx" ON "task_audits"("taskId");

-- CreateIndex
CREATE INDEX "task_audits_action_idx" ON "task_audits"("action");

-- CreateIndex
CREATE INDEX "task_audits_createdAt_idx" ON "task_audits"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "task_configurations_key_key" ON "task_configurations"("key");

-- CreateIndex
CREATE INDEX "treasure_audits_roomId_idx" ON "treasure_audits"("roomId");

-- CreateIndex
CREATE INDEX "treasure_audits_boxId_idx" ON "treasure_audits"("boxId");

-- CreateIndex
CREATE INDEX "treasure_audits_createdAt_idx" ON "treasure_audits"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "financial_policies_key_key" ON "financial_policies"("key");

-- CreateIndex
CREATE INDEX "financial_policies_category_idx" ON "financial_policies"("category");

-- CreateIndex
CREATE INDEX "treasury_logs_operation_idx" ON "treasury_logs"("operation");

-- CreateIndex
CREATE INDEX "treasury_logs_createdAt_idx" ON "treasury_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "vip_tiers_level_key" ON "vip_tiers"("level");

-- CreateIndex
CREATE UNIQUE INDEX "vip_memberships_userId_key" ON "vip_memberships"("userId");

-- CreateIndex
CREATE INDEX "vip_memberships_userId_idx" ON "vip_memberships"("userId");

-- CreateIndex
CREATE INDEX "vip_memberships_status_idx" ON "vip_memberships"("status");

-- CreateIndex
CREATE INDEX "vip_memberships_expiresAt_idx" ON "vip_memberships"("expiresAt");

-- CreateIndex
CREATE INDEX "vip_subscriptions_userId_idx" ON "vip_subscriptions"("userId");

-- CreateIndex
CREATE INDEX "vip_subscriptions_createdAt_idx" ON "vip_subscriptions"("createdAt");

-- CreateIndex
CREATE INDEX "vip_rewards_userId_rewardType_idx" ON "vip_rewards"("userId", "rewardType");

-- CreateIndex
CREATE INDEX "vip_histories_userId_createdAt_idx" ON "vip_histories"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "vip_audits_userId_idx" ON "vip_audits"("userId");

-- CreateIndex
CREATE INDEX "vip_audits_createdAt_idx" ON "vip_audits"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "vip_statistics_period_dateKey_key" ON "vip_statistics"("period", "dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "vip_configurations_key_key" ON "vip_configurations"("key");

-- CreateIndex
CREATE INDEX "ledger_entries_walletId_createdAt_idx" ON "ledger_entries"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_entries_transactionId_idx" ON "ledger_entries"("transactionId");

-- CreateIndex
CREATE INDEX "ledger_entries_referenceType_referenceId_idx" ON "ledger_entries"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "wallet_reservations_walletId_status_idx" ON "wallet_reservations"("walletId", "status");

-- CreateIndex
CREATE INDEX "wallet_reservations_expiresAt_idx" ON "wallet_reservations"("expiresAt");

-- CreateIndex
CREATE INDEX "wallet_audits_walletId_idx" ON "wallet_audits"("walletId");

-- CreateIndex
CREATE INDEX "wallet_audits_createdAt_idx" ON "wallet_audits"("createdAt");

-- CreateIndex
CREATE INDEX "withdrawal_requests_userId_createdAt_idx" ON "withdrawal_requests"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "withdrawal_requests_status_idx" ON "withdrawal_requests"("status");

-- CreateIndex
CREATE INDEX "withdrawal_reviews_requestId_idx" ON "withdrawal_reviews"("requestId");

-- CreateIndex
CREATE INDEX "withdrawal_failures_requestId_idx" ON "withdrawal_failures"("requestId");

-- CreateIndex
CREATE INDEX "withdrawal_histories_userId_createdAt_idx" ON "withdrawal_histories"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "withdrawal_histories_requestId_idx" ON "withdrawal_histories"("requestId");

-- CreateIndex
CREATE INDEX "withdrawal_audits_userId_idx" ON "withdrawal_audits"("userId");

-- CreateIndex
CREATE INDEX "withdrawal_audits_createdAt_idx" ON "withdrawal_audits"("createdAt");

-- CreateIndex
CREATE INDEX "withdrawal_statistics_userId_period_idx" ON "withdrawal_statistics"("userId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_statistics_userId_period_dateKey_key" ON "withdrawal_statistics"("userId", "period", "dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_configurations_key_key" ON "withdrawal_configurations"("key");

-- CreateIndex
CREATE UNIQUE INDEX "audio_rooms_ownerId_key" ON "audio_rooms"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "families_tag_key" ON "families"("tag");

-- CreateIndex
CREATE INDEX "families_founderId_idx" ON "families"("founderId");

-- CreateIndex
CREATE INDEX "families_status_idx" ON "families"("status");

-- CreateIndex
CREATE INDEX "families_tag_idx" ON "families"("tag");

-- CreateIndex
CREATE INDEX "family_join_requests_familyId_status_idx" ON "family_join_requests"("familyId", "status");

-- CreateIndex
CREATE INDEX "family_join_requests_userId_status_idx" ON "family_join_requests"("userId", "status");

-- CreateIndex
CREATE INDEX "family_members_familyId_role_idx" ON "family_members"("familyId", "role");

-- CreateIndex
CREATE INDEX "family_members_userId_idx" ON "family_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "gifts_code_key" ON "gifts"("code");

-- CreateIndex
CREATE INDEX "wallet_transactions_sourceWalletId_createdAt_idx" ON "wallet_transactions"("sourceWalletId", "createdAt");

-- CreateIndex
CREATE INDEX "wallet_transactions_destinationWalletId_createdAt_idx" ON "wallet_transactions"("destinationWalletId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_userId_key" ON "wallets"("userId");

-- CreateIndex
CREATE INDEX "wallets_userId_idx" ON "wallets"("userId");

-- CreateIndex
CREATE INDEX "wallets_type_idx" ON "wallets"("type");

-- CreateIndex
CREATE INDEX "wallets_status_idx" ON "wallets"("status");

-- CreateIndex
CREATE INDEX "wallets_version_idx" ON "wallets"("version");

-- AddForeignKey
ALTER TABLE "achievement_progresses" ADD CONSTRAINT "achievement_progresses_achievementId_fkey" FOREIGN KEY ("achievementId") REFERENCES "achievement_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_achievementId_fkey" FOREIGN KEY ("achievementId") REFERENCES "achievement_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "badge_inventories" ADD CONSTRAINT "badge_inventories_badgeCode_fkey" FOREIGN KEY ("badgeCode") REFERENCES "badge_definitions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "achievement_histories" ADD CONSTRAINT "achievement_histories_achievementId_fkey" FOREIGN KEY ("achievementId") REFERENCES "achievement_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "analytics_reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "event_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "event_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_rewards" ADD CONSTRAINT "event_rewards_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "event_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_entries" ADD CONSTRAINT "ranking_entries_rankingId_fkey" FOREIGN KEY ("rankingId") REFERENCES "ranking_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_ranking_snapshots" ADD CONSTRAINT "enterprise_ranking_snapshots_rankingId_fkey" FOREIGN KEY ("rankingId") REFERENCES "ranking_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_inventories" ADD CONSTRAINT "gift_inventories_giftId_fkey" FOREIGN KEY ("giftId") REFERENCES "gifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_availabilities" ADD CONSTRAINT "gift_availabilities_giftId_fkey" FOREIGN KEY ("giftId") REFERENCES "gifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_inboxes" ADD CONSTRAINT "notification_inboxes_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "enterprise_notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_histories" ADD CONSTRAINT "notification_histories_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "enterprise_notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "coin_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "setting_histories" ADD CONSTRAINT "setting_histories_settingId_fkey" FOREIGN KEY ("settingId") REFERENCES "platform_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_hierarchies" ADD CONSTRAINT "role_hierarchies_parentRoleId_fkey" FOREIGN KEY ("parentRoleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_hierarchies" ADD CONSTRAINT "role_hierarchies_childRoleId_fkey" FOREIGN KEY ("childRoleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "states" ADD CONSTRAINT "states_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regions" ADD CONSTRAINT "regions_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "states"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_scopes" ADD CONSTRAINT "role_scopes_userRoleId_fkey" FOREIGN KEY ("userRoleId") REFERENCES "user_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_scopes" ADD CONSTRAINT "role_scopes_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_scopes" ADD CONSTRAINT "role_scopes_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "states"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_scopes" ADD CONSTRAINT "role_scopes_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "referral_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_relationships" ADD CONSTRAINT "referral_relationships_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES "referral_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_relationships" ADD CONSTRAINT "referral_relationships_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "referral_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_qualifications" ADD CONSTRAINT "referral_qualifications_relationshipId_fkey" FOREIGN KEY ("relationshipId") REFERENCES "referral_relationships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_relationshipId_fkey" FOREIGN KEY ("relationshipId") REFERENCES "referral_relationships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_definitions" ADD CONSTRAINT "task_definitions_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "mission_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_progress" ADD CONSTRAINT "task_progress_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "task_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_progress" ADD CONSTRAINT "mission_progress_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "mission_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "wallet_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_reservations" ADD CONSTRAINT "wallet_reservations_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "video_room_pk_contributions_battleId_giftTxnId_participantId_ke" RENAME TO "video_room_pk_contributions_battleId_giftTxnId_participantI_key";

