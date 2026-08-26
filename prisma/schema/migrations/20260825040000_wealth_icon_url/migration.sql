-- Adds Super-Admin-uploadable icon art to Wealth Levels and Benefits.

-- AlterTable
ALTER TABLE "wealth_level_benefits" ADD COLUMN     "iconUrl" TEXT;

-- AlterTable
ALTER TABLE "wealth_levels" ADD COLUMN     "iconUrl" TEXT;
