-- CreateEnum
CREATE TYPE "VipLevel" AS ENUM ('NONE', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'ELITE', 'TITAN');

-- CreateTable
CREATE TABLE "vip_status" (
    "userId" UUID NOT NULL,
    "level" "VipLevel" NOT NULL DEFAULT 'NONE',
    "lifetimeRecharge" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vip_status_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "vip_configs" (
    "level" "VipLevel" NOT NULL,
    "minRecharge" BIGINT NOT NULL,
    "benefits" JSONB NOT NULL DEFAULT '[]',
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vip_configs_pkey" PRIMARY KEY ("level")
);

-- CreateTable
CREATE TABLE "vip_recharge_logs" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "totalAfter" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vip_recharge_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vip_logs" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "fromLevel" "VipLevel" NOT NULL,
    "toLevel" "VipLevel" NOT NULL,
    "lifetimeRecharge" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vip_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vip_recharge_logs_idempotencyKey_key" ON "vip_recharge_logs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "vip_recharge_logs_userId_createdAt_idx" ON "vip_recharge_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "vip_logs_userId_createdAt_idx" ON "vip_logs"("userId", "createdAt");
