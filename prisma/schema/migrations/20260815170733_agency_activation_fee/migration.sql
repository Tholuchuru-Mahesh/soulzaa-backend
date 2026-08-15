-- CreateEnum
CREATE TYPE "AgencyActivationStatus" AS ENUM ('PENDING', 'ACTIVATED', 'FAILED');

-- CreateTable
CREATE TABLE "agency_activations" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "AgencyActivationStatus" NOT NULL DEFAULT 'PENDING',
    "paymentProvider" TEXT,
    "paymentLinkId" TEXT,
    "paymentLinkUrl" TEXT,
    "providerTxnRef" TEXT,
    "paidAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_activations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agency_activations_agencyId_key" ON "agency_activations"("agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "agency_activations_idempotencyKey_key" ON "agency_activations"("idempotencyKey");

-- CreateIndex
CREATE INDEX "agency_activations_status_idx" ON "agency_activations"("status");
