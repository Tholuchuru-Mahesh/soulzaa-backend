-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('FESTIVAL', 'ANNIVERSARY', 'LUCKY_GIFT', 'DOUBLE_RECHARGE', 'DOUBLE_EXP', 'GENERIC');

-- CreateEnum
CREATE TYPE "EventVisibility" AS ENUM ('PUBLIC', 'HIDDEN');

-- CreateTable
CREATE TABLE "platform_events" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "EventType" NOT NULL,
    "description" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "visibility" "EventVisibility" NOT NULL DEFAULT 'PUBLIC',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "rewards" JSONB NOT NULL DEFAULT '[]',
    "multiplier" INTEGER NOT NULL DEFAULT 1,
    "eligibility" JSONB,
    "bannerUrl" TEXT,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_claims" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "rewardsSummary" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_events_enabled_type_idx" ON "platform_events"("enabled", "type");

-- CreateIndex
CREATE INDEX "platform_events_startAt_endAt_idx" ON "platform_events"("startAt", "endAt");

-- CreateIndex
CREATE UNIQUE INDEX "event_claims_idempotencyKey_key" ON "event_claims"("idempotencyKey");

-- CreateIndex
CREATE INDEX "event_claims_userId_createdAt_idx" ON "event_claims"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "event_claims_eventId_userId_key" ON "event_claims"("eventId", "userId");
