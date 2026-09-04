-- CreateEnum
CREATE TYPE "VideoRoomGiftLockAccessStatus" AS ENUM ('GRANTED', 'REVOKED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VideoRoomLogAction" ADD VALUE 'GIFT_LOCK_ENABLED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE 'GIFT_LOCK_DISABLED';

-- AlterTable
ALTER TABLE "video_rooms" ADD COLUMN     "giftLockEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requiredEntryGiftId" UUID;

-- CreateTable
CREATE TABLE "video_room_gift_lock_accesses" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "giftId" UUID NOT NULL,
    "giftTransactionId" UUID NOT NULL,
    "status" "VideoRoomGiftLockAccessStatus" NOT NULL DEFAULT 'GRANTED',
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_room_gift_lock_accesses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_room_gift_lock_accesses_roomId_sessionId_idx" ON "video_room_gift_lock_accesses"("roomId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "video_room_gift_lock_accesses_userId_sessionId_key" ON "video_room_gift_lock_accesses"("userId", "sessionId");

-- AddForeignKey
ALTER TABLE "video_room_gift_lock_accesses" ADD CONSTRAINT "video_room_gift_lock_accesses_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "video_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_room_gift_lock_accesses" ADD CONSTRAINT "video_room_gift_lock_accesses_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "video_broadcast_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
