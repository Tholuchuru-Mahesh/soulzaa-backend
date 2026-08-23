-- AlterTable
ALTER TABLE "user_statistics" ADD COLUMN     "visitorsCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "profile_visitors" (
    "id" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "visitorId" UUID NOT NULL,
    "visitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_visitors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "profile_visitors_profileId_idx" ON "profile_visitors"("profileId");

-- CreateIndex
CREATE INDEX "profile_visitors_visitorId_idx" ON "profile_visitors"("visitorId");

-- CreateIndex
CREATE UNIQUE INDEX "profile_visitors_profileId_visitorId_key" ON "profile_visitors"("profileId", "visitorId");

