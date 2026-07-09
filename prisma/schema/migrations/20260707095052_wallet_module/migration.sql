-- CreateEnum
CREATE TYPE "WalletCurrency" AS ENUM ('GOLD', 'FREE', 'EARNINGS');

-- CreateEnum
CREATE TYPE "WalletEntryType" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "WalletTxnReason" AS ENUM ('RECHARGE', 'GIFT_SEND', 'GIFT_RECEIVE', 'GIFT_REFUND', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'TREASURE_BOX', 'GAME_STAKE', 'GAME_PAYOUT', 'VIP_PURCHASE', 'EVENT_REWARD');

-- CreateTable
CREATE TABLE "wallets" (
    "userId" UUID NOT NULL,
    "goldBalance" BIGINT NOT NULL DEFAULT 0,
    "freeBalance" BIGINT NOT NULL DEFAULT 0,
    "earningsBalance" BIGINT NOT NULL DEFAULT 0,
    "totalRecharged" BIGINT NOT NULL DEFAULT 0,
    "totalGiftsSentValue" BIGINT NOT NULL DEFAULT 0,
    "totalGiftsReceivedValue" BIGINT NOT NULL DEFAULT 0,
    "totalSpent" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "currency" "WalletCurrency" NOT NULL,
    "type" "WalletEntryType" NOT NULL,
    "reason" "WalletTxnReason" NOT NULL,
    "amount" BIGINT NOT NULL,
    "balanceBefore" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "referenceType" TEXT,
    "referenceId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "metadata" JSONB,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_idempotencyKey_key" ON "wallet_transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "wallet_transactions_userId_createdAt_idx" ON "wallet_transactions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "wallet_transactions_referenceType_referenceId_idx" ON "wallet_transactions"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "wallet_transactions_reason_idx" ON "wallet_transactions"("reason");
