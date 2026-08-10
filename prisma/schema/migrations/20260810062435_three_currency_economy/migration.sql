/*
  Warnings:

  - The `status` column on the `withdrawal_requests` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `toStatus` on the `withdrawal_histories` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "InventoryPurchaseStatus" AS ENUM ('PENDING_PAYMENT', 'PAYMENT_VERIFIED', 'ADMIN_APPROVED', 'INVENTORY_CREDITED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CoinSaleStatus" AS ENUM ('COMPLETED', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'CANCELLED', 'FAILED');

-- AlterEnum
ALTER TYPE "GameCurrency" ADD VALUE 'GAME';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WalletCurrency" ADD VALUE 'DIAMOND';
ALTER TYPE "WalletCurrency" ADD VALUE 'GAME';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WalletTxnReason" ADD VALUE 'COIN_SELLER_CREDIT';
ALTER TYPE "WalletTxnReason" ADD VALUE 'GIFT_CASHBACK';
ALTER TYPE "WalletTxnReason" ADD VALUE 'DIAMOND_GIFT_EARNING';
ALTER TYPE "WalletTxnReason" ADD VALUE 'DIAMOND_WITHDRAWAL_RESERVE';
ALTER TYPE "WalletTxnReason" ADD VALUE 'DIAMOND_WITHDRAWAL_COMPLETED';
ALTER TYPE "WalletTxnReason" ADD VALUE 'DIAMOND_WITHDRAWAL_REVERSED';
ALTER TYPE "WalletTxnReason" ADD VALUE 'DIAMOND_ADJUSTMENT';
ALTER TYPE "WalletTxnReason" ADD VALUE 'GAME_DAILY_LOGIN';
ALTER TYPE "WalletTxnReason" ADD VALUE 'GAME_TASK_REWARD';
ALTER TYPE "WalletTxnReason" ADD VALUE 'GAME_EVENT_REWARD';
ALTER TYPE "WalletTxnReason" ADD VALUE 'GAME_SPIN_REWARD';
ALTER TYPE "WalletTxnReason" ADD VALUE 'GAME_ACHIEVEMENT_REWARD';
ALTER TYPE "WalletTxnReason" ADD VALUE 'GAME_PROMOTIONAL_REWARD';
ALTER TYPE "WalletTxnReason" ADD VALUE 'GAME_COIN_STAKE';
ALTER TYPE "WalletTxnReason" ADD VALUE 'GAME_COIN_WIN';
ALTER TYPE "WalletTxnReason" ADD VALUE 'GAME_COIN_REFUND';

-- AlterTable
ALTER TABLE "gift_transactions" ADD COLUMN     "appliedCashbackPct" INTEGER,
ADD COLUMN     "appliedEarningsPct" INTEGER,
ADD COLUMN     "cashbackAmount" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "wallets" ADD COLUMN     "diamondBalance" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "gameBalance" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "withdrawal_histories" DROP COLUMN "toStatus",
ADD COLUMN     "toStatus" "WithdrawalStatus" NOT NULL;

-- AlterTable
ALTER TABLE "withdrawal_requests" DROP COLUMN "status",
ADD COLUMN     "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "coin_seller_inventories" (
    "id" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "country" TEXT NOT NULL,
    "purchasedTotal" BIGINT NOT NULL DEFAULT 0,
    "availableBalance" BIGINT NOT NULL DEFAULT 0,
    "reservedBalance" BIGINT NOT NULL DEFAULT 0,
    "soldTotal" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_seller_inventories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_seller_inventory_purchase_orders" (
    "id" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "inventoryId" UUID NOT NULL,
    "packageCode" TEXT NOT NULL,
    "coinAmount" BIGINT NOT NULL,
    "priceAmount" DECIMAL(14,2) NOT NULL,
    "priceCurrency" TEXT NOT NULL DEFAULT 'INR',
    "status" "InventoryPurchaseStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "paymentProvider" TEXT,
    "providerTxnRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "approvedBy" UUID,
    "approvedAt" TIMESTAMP(3),
    "creditedAt" TIMESTAMP(3),
    "walletTxnId" UUID,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_seller_inventory_purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_seller_user_sale_transactions" (
    "id" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "inventoryId" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "coinAmount" BIGINT NOT NULL,
    "sellerCountry" TEXT NOT NULL,
    "buyerCountry" TEXT NOT NULL,
    "status" "CoinSaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "idempotencyKey" TEXT NOT NULL,
    "buyerWalletTxnId" UUID,
    "inventoryTxnRef" TEXT,
    "paymentProofRef" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coin_seller_user_sale_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_seller_inventory_audits" (
    "id" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "inventoryId" UUID,
    "action" TEXT NOT NULL,
    "coinDelta" BIGINT NOT NULL DEFAULT 0,
    "balanceBefore" BIGINT,
    "balanceAfter" BIGINT,
    "referenceId" UUID,
    "referenceType" TEXT,
    "actorId" UUID,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coin_seller_inventory_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_seller_inventory_packages" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "coinAmount" BIGINT NOT NULL,
    "priceAmount" DECIMAL(14,2) NOT NULL,
    "priceCurrency" TEXT NOT NULL DEFAULT 'INR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_seller_inventory_packages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coin_seller_inventories_sellerId_key" ON "coin_seller_inventories"("sellerId");

-- CreateIndex
CREATE INDEX "coin_seller_inventories_sellerId_idx" ON "coin_seller_inventories"("sellerId");

-- CreateIndex
CREATE INDEX "coin_seller_inventories_country_idx" ON "coin_seller_inventories"("country");

-- CreateIndex
CREATE UNIQUE INDEX "coin_seller_inventory_purchase_orders_idempotencyKey_key" ON "coin_seller_inventory_purchase_orders"("idempotencyKey");

-- CreateIndex
CREATE INDEX "coin_seller_inventory_purchase_orders_sellerId_createdAt_idx" ON "coin_seller_inventory_purchase_orders"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "coin_seller_inventory_purchase_orders_status_idx" ON "coin_seller_inventory_purchase_orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "coin_seller_user_sale_transactions_idempotencyKey_key" ON "coin_seller_user_sale_transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "coin_seller_user_sale_transactions_sellerId_createdAt_idx" ON "coin_seller_user_sale_transactions"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "coin_seller_user_sale_transactions_buyerId_createdAt_idx" ON "coin_seller_user_sale_transactions"("buyerId", "createdAt");

-- CreateIndex
CREATE INDEX "coin_seller_user_sale_transactions_status_idx" ON "coin_seller_user_sale_transactions"("status");

-- CreateIndex
CREATE INDEX "coin_seller_inventory_audits_sellerId_createdAt_idx" ON "coin_seller_inventory_audits"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "coin_seller_inventory_audits_action_idx" ON "coin_seller_inventory_audits"("action");

-- CreateIndex
CREATE UNIQUE INDEX "coin_seller_inventory_packages_code_key" ON "coin_seller_inventory_packages"("code");

-- CreateIndex
CREATE INDEX "coin_seller_inventory_packages_isActive_idx" ON "coin_seller_inventory_packages"("isActive");

-- CreateIndex
CREATE INDEX "withdrawal_requests_status_idx" ON "withdrawal_requests"("status");

-- AddForeignKey
ALTER TABLE "coin_seller_inventory_purchase_orders" ADD CONSTRAINT "coin_seller_inventory_purchase_orders_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "coin_seller_inventories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coin_seller_user_sale_transactions" ADD CONSTRAINT "coin_seller_user_sale_transactions_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "coin_seller_inventories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
