-- CreateEnum
CREATE TYPE "CosmeticType" AS ENUM ('FRAME', 'BADGE', 'ENTRANCE_EFFECT', 'THEME', 'DECORATION');

-- CreateEnum
CREATE TYPE "CosmeticRarity" AS ENUM ('COMMON', 'RARE', 'EPIC', 'LEGENDARY');

-- CreateTable
CREATE TABLE "cosmetics" (
    "id" UUID NOT NULL,
    "type" "CosmeticType" NOT NULL,
    "name" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "thumbnailUrl" TEXT,
    "rarity" "CosmeticRarity" NOT NULL DEFAULT 'COMMON',
    "transferable" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cosmetics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cosmetics_enabled_type_idx" ON "cosmetics"("enabled", "type");

-- CreateIndex
CREATE UNIQUE INDEX "cosmetics_type_name_key" ON "cosmetics"("type", "name");
