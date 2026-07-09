-- CreateTable
CREATE TABLE "room_appearance" (
    "roomId" UUID NOT NULL,
    "themeCosmeticId" UUID,
    "themeName" TEXT,
    "decorationCosmeticIds" UUID[],
    "decorationNames" TEXT[],
    "updatedBy" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_appearance_pkey" PRIMARY KEY ("roomId")
);
