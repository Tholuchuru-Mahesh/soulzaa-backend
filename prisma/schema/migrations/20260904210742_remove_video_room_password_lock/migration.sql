/*
  Warnings:

  - You are about to drop the column `isLocked` on the `video_rooms` table. All the data in the column will be lost.
  - You are about to drop the column `passwordHash` on the `video_rooms` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "video_rooms" DROP COLUMN "isLocked",
DROP COLUMN "passwordHash";
