-- CreateEnum
CREATE TYPE "AgencyTaskMetric" AS ENUM ('ACTIVE_MEMBERS', 'NEW_MEMBERS', 'COIN_SALES', 'GIFT_REVENUE', 'REWARDS_DISTRIBUTED', 'MANUAL');

-- CreateEnum
CREATE TYPE "AgencyTaskStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AgencyTaskPriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "AgencyRewardKind" AS ENUM ('ASSIGNED', 'OWNED');

-- AlterEnum
ALTER TYPE "BackpackItemSource" ADD VALUE 'AGENCY';

-- CreateTable
CREATE TABLE "agency_tasks" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "assignedById" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "metric" "AgencyTaskMetric" NOT NULL,
    "targetValue" BIGINT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "AgencyTaskStatus" NOT NULL DEFAULT 'ACTIVE',
    "priority" "AgencyTaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "completedAt" TIMESTAMP(3),
    "completedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agency_reward_inventories" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "itemType" TEXT NOT NULL,
    "refId" TEXT,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "allocatedTotal" INTEGER NOT NULL DEFAULT 0,
    "distributedTotal" INTEGER NOT NULL DEFAULT 0,
    "allocatedBy" UUID,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_reward_inventories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agency_reward_distributions" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "inventoryId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "itemType" TEXT NOT NULL,
    "refId" TEXT,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "kind" "AgencyRewardKind" NOT NULL DEFAULT 'ASSIGNED',
    "backpackItemId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agency_reward_distributions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agency_tasks_agencyId_status_idx" ON "agency_tasks"("agencyId", "status");

-- CreateIndex
CREATE INDEX "agency_tasks_agencyId_periodEnd_idx" ON "agency_tasks"("agencyId", "periodEnd");

-- CreateIndex
CREATE INDEX "agency_reward_inventories_agencyId_idx" ON "agency_reward_inventories"("agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "agency_reward_inventories_agencyId_itemType_refId_key" ON "agency_reward_inventories"("agencyId", "itemType", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "agency_reward_distributions_idempotencyKey_key" ON "agency_reward_distributions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "agency_reward_distributions_agencyId_createdAt_idx" ON "agency_reward_distributions"("agencyId", "createdAt");

-- CreateIndex
CREATE INDEX "agency_reward_distributions_recipientId_createdAt_idx" ON "agency_reward_distributions"("recipientId", "createdAt");

-- AddForeignKey
ALTER TABLE "agency_reward_distributions" ADD CONSTRAINT "agency_reward_distributions_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "agency_reward_inventories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
