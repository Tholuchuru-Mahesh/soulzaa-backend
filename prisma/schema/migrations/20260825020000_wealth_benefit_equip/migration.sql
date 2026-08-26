-- Which unlocked Wealth Level benefit a user has chosen to display, one per
-- benefitType slot (one Badge, one Profile Frame, one Chat Bubble, etc.
-- equipped at a time).

-- CreateTable
CREATE TABLE "wealth_benefit_equips" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "benefitType" "WealthBenefitType" NOT NULL,
    "benefitId" UUID NOT NULL,
    "equippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wealth_benefit_equips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wealth_benefit_equips_userId_idx" ON "wealth_benefit_equips"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "wealth_benefit_equips_userId_benefitType_key" ON "wealth_benefit_equips"("userId", "benefitType");

-- AddForeignKey
ALTER TABLE "wealth_benefit_equips" ADD CONSTRAINT "wealth_benefit_equips_benefitId_fkey" FOREIGN KEY ("benefitId") REFERENCES "wealth_level_benefits"("id") ON DELETE CASCADE ON UPDATE CASCADE;
