-- CreateEnum
CREATE TYPE "AgencyJoinRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED');

-- CreateTable
CREATE TABLE "agency_join_requests" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "AgencyJoinRequestStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_join_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agency_join_requests_agencyId_status_idx" ON "agency_join_requests"("agencyId", "status");

-- CreateIndex
CREATE INDEX "agency_join_requests_userId_status_idx" ON "agency_join_requests"("userId", "status");
