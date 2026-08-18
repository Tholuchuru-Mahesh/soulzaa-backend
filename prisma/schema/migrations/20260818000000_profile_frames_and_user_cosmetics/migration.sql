-- AlterEnum
ALTER TYPE "GiftType" ADD VALUE 'PROFILE_FRAME';

-- AlterTable
ALTER TABLE "gifts" ADD COLUMN     "ttlUnit" TEXT,
ADD COLUMN     "ttlValue" INTEGER;

-- CreateTable
CREATE TABLE "user_cosmetics" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "cosmeticId" UUID NOT NULL,
    "equipped" BOOLEAN NOT NULL DEFAULT false,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_cosmetics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_cosmetics_userId_equipped_idx" ON "user_cosmetics"("userId", "equipped");

-- CreateIndex
CREATE UNIQUE INDEX "user_cosmetics_userId_cosmeticId_key" ON "user_cosmetics"("userId", "cosmeticId");

-- AddForeignKey
ALTER TABLE "user_cosmetics" ADD CONSTRAINT "user_cosmetics_cosmeticId_fkey" FOREIGN KEY ("cosmeticId") REFERENCES "cosmetics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

