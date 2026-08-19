-- AlterTable
ALTER TABLE "event_definitions" ADD COLUMN     "agencyId" UUID,
ADD COLUMN     "createdBy" UUID;

-- CreateIndex
CREATE INDEX "event_definitions_agencyId_status_idx" ON "event_definitions"("agencyId", "status");
