-- AlterTable
ALTER TABLE "room_members" ADD COLUMN     "tempSpeakAllowed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "seat_requests" ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'BECOME_SPEAKER';
