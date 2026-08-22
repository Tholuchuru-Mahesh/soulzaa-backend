-- CreateEnum
CREATE TYPE "BroadBanStatus" AS ENUM ('ACTIVE', 'LIFTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "broad_bans" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "roomType" "PlatformRoomType" NOT NULL,
    "ownerId" UUID NOT NULL,
    "moderatorId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "proofUrl" TEXT,
    "status" "BroadBanStatus" NOT NULL DEFAULT 'ACTIVE',
    "bannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "liftedAt" TIMESTAMP(3),
    "liftedBy" UUID,

    CONSTRAINT "broad_bans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "broad_bans_ownerId_status_idx" ON "broad_bans"("ownerId", "status");

-- CreateIndex
CREATE INDEX "broad_bans_status_expiresAt_idx" ON "broad_bans"("status", "expiresAt");

