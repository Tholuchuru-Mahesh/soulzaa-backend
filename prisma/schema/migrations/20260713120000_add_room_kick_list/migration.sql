-- AlterEnum
ALTER TYPE "ModerationActionType" ADD VALUE 'UNKICK';

-- CreateTable
CREATE TABLE "room_kicks" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "moderatorId" UUID NOT NULL,
    "reason" TEXT,
    "status" "ModerationStatus" NOT NULL DEFAULT 'ACTIVE',
    "liftedBy" UUID,
    "liftedAt" TIMESTAMP(3),
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_kicks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_kicks_roomId_status_idx" ON "room_kicks"("roomId", "status");

-- CreateIndex
CREATE INDEX "room_kicks_userId_status_idx" ON "room_kicks"("userId", "status");
