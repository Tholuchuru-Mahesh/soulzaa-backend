-- CreateEnum
CREATE TYPE "AgencyJoinInitiator" AS ENUM ('USER', 'AGENCY');

-- AlterTable
ALTER TABLE "agency_join_requests" ADD COLUMN     "initiatedBy" "AgencyJoinInitiator" NOT NULL DEFAULT 'USER';
