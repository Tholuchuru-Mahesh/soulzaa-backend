-- CreateEnum
CREATE TYPE "VoicePublishRole" AS ENUM ('PUBLISHER', 'SUBSCRIBER');

-- CreateEnum
CREATE TYPE "VoiceSessionStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "VoiceSessionAction" AS ENUM ('JOINED', 'LEFT', 'MUTED', 'UNMUTED', 'RECONNECTED', 'NETWORK_LOST', 'NETWORK_RECOVERED', 'QUALITY_SAMPLED', 'SPEAKING_STARTED', 'SPEAKING_STOPPED', 'ROUTE_SWITCHED', 'BACKGROUND_ENTERED', 'BACKGROUND_EXITED', 'ROLE_CHANGED', 'HEARTBEAT_TIMEOUT');

-- AlterTable
ALTER TABLE "audio_rooms" ADD COLUMN     "zegoRoomId" TEXT;

-- CreateTable
CREATE TABLE "voice_sessions" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "zegoRoomId" TEXT NOT NULL,
    "role" "VoicePublishRole" NOT NULL DEFAULT 'SUBSCRIBER',
    "status" "VoiceSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "selfMuted" BOOLEAN NOT NULL DEFAULT false,
    "isSpeaking" BOOLEAN NOT NULL DEFAULT false,
    "inBackground" BOOLEAN NOT NULL DEFAULT false,
    "audioRoute" TEXT,
    "reconnectCount" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "durationSeconds" BIGINT NOT NULL DEFAULT 0,
    "lastQualityLevel" INTEGER,
    "avgRttMs" INTEGER,
    "worstRttMs" INTEGER,
    "avgPacketLossPct" DOUBLE PRECISION,
    "qualitySampleCount" INTEGER NOT NULL DEFAULT 0,
    "lastReportAt" TIMESTAMP(3),
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_session_logs" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "action" "VoiceSessionAction" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_session_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voice_sessions_roomId_idx" ON "voice_sessions"("roomId");

-- CreateIndex
CREATE INDEX "voice_sessions_status_idx" ON "voice_sessions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "voice_sessions_roomId_userId_key" ON "voice_sessions"("roomId", "userId");

-- CreateIndex
CREATE INDEX "voice_session_logs_roomId_idx" ON "voice_session_logs"("roomId");

-- CreateIndex
CREATE INDEX "voice_session_logs_action_idx" ON "voice_session_logs"("action");

-- CreateIndex
CREATE UNIQUE INDEX "audio_rooms_zegoRoomId_key" ON "audio_rooms"("zegoRoomId");

