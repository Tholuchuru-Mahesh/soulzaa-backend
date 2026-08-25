-- AlterTable
ALTER TABLE "user_verification" ADD COLUMN     "category" TEXT;

-- CreateIndex
CREATE INDEX "user_verification_status_idx" ON "user_verification"("status");

-- CreateIndex
CREATE INDEX "user_verification_category_idx" ON "user_verification"("category");
