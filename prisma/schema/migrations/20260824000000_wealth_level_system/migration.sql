-- CreateEnum
CREATE TYPE "WealthBenefitType" AS ENUM ('BADGE', 'PROFILE_FRAME', 'AVATAR_EFFECT', 'CHAT_BUBBLE', 'CHAT_EFFECT', 'ROOM_EFFECT', 'GIFT_EFFECT', 'THEME', 'ANIMATION', 'PROFILE_STYLE', 'OTHER');

-- CreateEnum
CREATE TYPE "WealthRewardType" AS ENUM ('GOLD_COINS', 'COSMETIC', 'BADGE', 'PROFILE_FRAME', 'OTHER');

-- CreateEnum
CREATE TYPE "WealthRewardFrequency" AS ENUM ('ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "WealthRewardGrantType" AS ENUM ('AUTOMATIC', 'CLAIMABLE');

-- CreateEnum
CREATE TYPE "WealthClaimStatus" AS ENUM ('GRANTED', 'CLAIMED');

-- CreateEnum
CREATE TYPE "WealthExpDirection" AS ENUM ('AWARD', 'REVERSAL');

-- CreateEnum
CREATE TYPE "WealthExpSourceType" AS ENUM ('GOLD_COIN_PURCHASE', 'PURCHASE_REVERSAL', 'ADMIN_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "WealthResetRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "WealthDowngradePolicy" AS ENUM ('STANDARD');

-- AlterTable
ALTER TABLE "user_statistics" ADD COLUMN     "wealthLevel" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "wealth_levels" (
    "id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "expThreshold" BIGINT NOT NULL DEFAULT 0,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wealth_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wealth_level_benefits" (
    "id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "benefitType" "WealthBenefitType" NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wealth_level_benefits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wealth_level_rewards" (
    "id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "rewardType" "WealthRewardType" NOT NULL,
    "rewardValue" JSONB NOT NULL DEFAULT '{}',
    "frequency" "WealthRewardFrequency" NOT NULL DEFAULT 'ONE_TIME',
    "grantType" "WealthRewardGrantType" NOT NULL DEFAULT 'AUTOMATIC',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wealth_level_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wealth_reward_claims" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "rewardId" UUID NOT NULL,
    "periodKey" TEXT NOT NULL,
    "status" "WealthClaimStatus" NOT NULL DEFAULT 'GRANTED',
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "wealth_reward_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wealth_user_progress" (
    "userId" UUID NOT NULL,
    "currentExp" BIGINT NOT NULL DEFAULT 0,
    "currentLevel" INTEGER NOT NULL DEFAULT 0,
    "periodKey" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wealth_user_progress_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "wealth_exp_ledger" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "direction" "WealthExpDirection" NOT NULL,
    "amount" BIGINT NOT NULL,
    "sourceType" "WealthExpSourceType" NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wealth_exp_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wealth_monthly_history" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "periodKey" TEXT NOT NULL,
    "startingLevel" INTEGER NOT NULL,
    "finalExp" BIGINT NOT NULL,
    "finalLevel" INTEGER NOT NULL,
    "downgradedToLevel" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wealth_monthly_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wealth_monthly_reset_runs" (
    "id" UUID NOT NULL,
    "periodKey" TEXT NOT NULL,
    "status" "WealthResetRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "usersProcessed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wealth_monthly_reset_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wealth_downgrade_config" (
    "id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "maxDowngradeLevels" INTEGER NOT NULL DEFAULT 1,
    "minLevel" INTEGER NOT NULL DEFAULT 0,
    "policy" "WealthDowngradePolicy" NOT NULL DEFAULT 'STANDARD',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wealth_downgrade_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wealth_configuration" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wealth_configuration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wealth_audit" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "oldValue" JSONB,
    "newValue" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wealth_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wealth_levels_level_key" ON "wealth_levels"("level");

-- CreateIndex
CREATE INDEX "wealth_levels_isActive_idx" ON "wealth_levels"("isActive");

-- CreateIndex
CREATE INDEX "wealth_level_benefits_level_idx" ON "wealth_level_benefits"("level");

-- CreateIndex
CREATE INDEX "wealth_level_benefits_isActive_idx" ON "wealth_level_benefits"("isActive");

-- CreateIndex
CREATE INDEX "wealth_level_rewards_level_idx" ON "wealth_level_rewards"("level");

-- CreateIndex
CREATE INDEX "wealth_level_rewards_isActive_idx" ON "wealth_level_rewards"("isActive");

-- CreateIndex
CREATE INDEX "wealth_reward_claims_userId_idx" ON "wealth_reward_claims"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "wealth_reward_claims_userId_rewardId_periodKey_key" ON "wealth_reward_claims"("userId", "rewardId", "periodKey");

-- CreateIndex
CREATE INDEX "wealth_user_progress_periodKey_idx" ON "wealth_user_progress"("periodKey");

-- CreateIndex
CREATE INDEX "wealth_user_progress_currentLevel_idx" ON "wealth_user_progress"("currentLevel");

-- CreateIndex
CREATE UNIQUE INDEX "wealth_exp_ledger_idempotencyKey_key" ON "wealth_exp_ledger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "wealth_exp_ledger_userId_createdAt_idx" ON "wealth_exp_ledger"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "wealth_exp_ledger_periodKey_idx" ON "wealth_exp_ledger"("periodKey");

-- CreateIndex
CREATE INDEX "wealth_exp_ledger_sourceRef_idx" ON "wealth_exp_ledger"("sourceRef");

-- CreateIndex
CREATE INDEX "wealth_monthly_history_periodKey_idx" ON "wealth_monthly_history"("periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "wealth_monthly_history_userId_periodKey_key" ON "wealth_monthly_history"("userId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "wealth_monthly_reset_runs_periodKey_key" ON "wealth_monthly_reset_runs"("periodKey");

-- CreateIndex
CREATE INDEX "wealth_downgrade_config_effectiveFrom_idx" ON "wealth_downgrade_config"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "wealth_configuration_key_key" ON "wealth_configuration"("key");

-- CreateIndex
CREATE INDEX "wealth_audit_actorId_idx" ON "wealth_audit"("actorId");

-- CreateIndex
CREATE INDEX "wealth_audit_createdAt_idx" ON "wealth_audit"("createdAt");

-- CreateIndex
CREATE INDEX "wealth_audit_entityType_entityId_idx" ON "wealth_audit"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "wealth_level_benefits" ADD CONSTRAINT "wealth_level_benefits_level_fkey" FOREIGN KEY ("level") REFERENCES "wealth_levels"("level") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wealth_level_rewards" ADD CONSTRAINT "wealth_level_rewards_level_fkey" FOREIGN KEY ("level") REFERENCES "wealth_levels"("level") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wealth_reward_claims" ADD CONSTRAINT "wealth_reward_claims_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "wealth_level_rewards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

