-- CreateEnum
CREATE TYPE "PremiumSeatStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "WatchPartyStatus" AS ENUM ('PLAYING', 'PAUSED', 'STOPPED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WalletTxnReason" ADD VALUE 'COSMETIC_PURCHASE';
ALTER TYPE "WalletTxnReason" ADD VALUE 'PREMIUM_SEAT';

-- AlterTable
ALTER TABLE "cosmetics" ADD COLUMN     "isPremium" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "price" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "premium_admin_seats" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "price" BIGINT NOT NULL,
    "walletTxnId" UUID,
    "status" "PremiumSeatStatus" NOT NULL DEFAULT 'ACTIVE',
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedBy" UUID,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "premium_admin_seats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_watch_party" (
    "roomId" UUID NOT NULL,
    "videoId" TEXT,
    "status" "WatchPartyStatus" NOT NULL DEFAULT 'STOPPED',
    "positionSeconds" INTEGER NOT NULL DEFAULT 0,
    "controlledBy" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_watch_party_pkey" PRIMARY KEY ("roomId")
);

-- CreateTable
CREATE TABLE "cosmetic_purchases" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "cosmeticId" UUID NOT NULL,
    "price" BIGINT NOT NULL,
    "walletTxnId" UUID,
    "backpackItemId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cosmetic_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "premium_admin_seats_roomId_status_idx" ON "premium_admin_seats"("roomId", "status");

-- CreateIndex
CREATE INDEX "premium_admin_seats_userId_status_idx" ON "premium_admin_seats"("userId", "status");

-- CreateIndex
CREATE INDEX "premium_admin_seats_status_expiresAt_idx" ON "premium_admin_seats"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "cosmetic_purchases_idempotencyKey_key" ON "cosmetic_purchases"("idempotencyKey");

-- CreateIndex
CREATE INDEX "cosmetic_purchases_userId_createdAt_idx" ON "cosmetic_purchases"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "cosmetic_purchases_cosmeticId_idx" ON "cosmetic_purchases"("cosmeticId");

-- CreateIndex
CREATE INDEX "cosmetics_isPremium_enabled_idx" ON "cosmetics"("isPremium", "enabled");
