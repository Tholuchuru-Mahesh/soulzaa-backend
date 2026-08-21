-- CreateEnum
CREATE TYPE "OfficialInventoryCategory" AS ENUM ('GIFT', 'FRAME', 'ENTRY_EFFECT', 'THEME', 'REWARD', 'BADGE', 'OTHER');

-- CreateEnum
CREATE TYPE "InventoryRecipientType" AS ENUM ('AGENCY', 'CREATOR', 'USER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ContentRequestCategory" ADD VALUE 'BANNER';
ALTER TYPE "ContentRequestCategory" ADD VALUE 'POSTER';
ALTER TYPE "ContentRequestCategory" ADD VALUE 'ENTRY_EFFECT';
ALTER TYPE "ContentRequestCategory" ADD VALUE 'FESTIVAL_GIFT';
ALTER TYPE "ContentRequestCategory" ADD VALUE 'CONTENT';

-- AlterEnum
ALTER TYPE "ContentRequestStatus" ADD VALUE 'APPROVED';

-- AlterTable
ALTER TABLE "content_requests" ADD COLUMN     "metadata" JSONB;

-- CreateTable
CREATE TABLE "official_inventory_items" (
    "id" UUID NOT NULL,
    "officialId" UUID NOT NULL,
    "category" "OfficialInventoryCategory" NOT NULL DEFAULT 'GIFT',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "thumbnailUrl" TEXT,
    "availableQty" INTEGER NOT NULL DEFAULT 0,
    "distributedQty" INTEGER NOT NULL DEFAULT 0,
    "reservedQty" INTEGER NOT NULL DEFAULT 0,
    "totalReceivedQty" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'Manager',
    "relatedEventId" UUID,
    "relatedEventName" TEXT,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 20,
    "metadata" JSONB DEFAULT '{}',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "official_inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "official_inventory_dispatches" (
    "id" UUID NOT NULL,
    "officialId" UUID NOT NULL,
    "inventoryItemId" UUID NOT NULL,
    "recipientType" "InventoryRecipientType" NOT NULL DEFAULT 'USER',
    "recipientId" UUID,
    "recipientName" TEXT NOT NULL,
    "recipientCode" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT NOT NULL DEFAULT 'Event reward',
    "remarks" TEXT,
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "official_inventory_dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "official_inventory_items_officialId_category_idx" ON "official_inventory_items"("officialId", "category");

-- CreateIndex
CREATE INDEX "official_inventory_items_officialId_receivedAt_idx" ON "official_inventory_items"("officialId", "receivedAt");

-- CreateIndex
CREATE INDEX "official_inventory_dispatches_officialId_dispatchedAt_idx" ON "official_inventory_dispatches"("officialId", "dispatchedAt");

-- CreateIndex
CREATE INDEX "official_inventory_dispatches_inventoryItemId_idx" ON "official_inventory_dispatches"("inventoryItemId");

-- AddForeignKey
ALTER TABLE "official_inventory_dispatches" ADD CONSTRAINT "official_inventory_dispatches_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "official_inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

