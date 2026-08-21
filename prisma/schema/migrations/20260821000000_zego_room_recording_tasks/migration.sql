-- CreateEnum
CREATE TYPE "ZegoRoomRecordingRoomType" AS ENUM ('audio', 'video', 'stream');

-- CreateEnum
CREATE TYPE "ZegoRoomRecordingTaskStatus" AS ENUM ('ACTIVE', 'STOPPED', 'FAILED');

-- CreateTable
CREATE TABLE "zego_room_recording_tasks" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "taskId" TEXT NOT NULL,
    "roomType" "ZegoRoomRecordingRoomType" NOT NULL,
    "status" "ZegoRoomRecordingTaskStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),
    "segments" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zego_room_recording_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "zego_room_recording_tasks_roomId_key" ON "zego_room_recording_tasks"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "zego_room_recording_tasks_taskId_key" ON "zego_room_recording_tasks"("taskId");

-- CreateIndex
CREATE INDEX "zego_room_recording_tasks_status_idx" ON "zego_room_recording_tasks"("status");

