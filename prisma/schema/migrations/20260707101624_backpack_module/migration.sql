-- CreateEnum
CREATE TYPE "BackpackItemType" AS ENUM ('FRAME', 'THEME', 'ENTRANCE_EFFECT', 'BADGE', 'DECORATION', 'OTHER');

-- CreateEnum
CREATE TYPE "BackpackItemSource" AS ENUM ('TREASURE_BOX', 'ROCKET', 'GIFT', 'EVENT', 'ATTENDANCE', 'ADMIN', 'PURCHASE');

-- CreateTable
CREATE TABLE "backpack_items" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "BackpackItemType" NOT NULL,
    "refId" TEXT,
    "name" TEXT NOT NULL,
    "source" "BackpackItemSource" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "equipped" BOOLEAN NOT NULL DEFAULT false,
    "transferable" BOOLEAN NOT NULL DEFAULT false,
    "grantKey" TEXT NOT NULL,
    "metadata" JSONB,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backpack_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backpack_logs" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "itemId" UUID,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backpack_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "backpack_items_grantKey_key" ON "backpack_items"("grantKey");

-- CreateIndex
CREATE INDEX "backpack_items_userId_type_idx" ON "backpack_items"("userId", "type");

-- CreateIndex
CREATE INDEX "backpack_items_userId_equipped_idx" ON "backpack_items"("userId", "equipped");

-- CreateIndex
CREATE INDEX "backpack_logs_userId_createdAt_idx" ON "backpack_logs"("userId", "createdAt");
