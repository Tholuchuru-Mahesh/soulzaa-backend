-- CreateEnum
CREATE TYPE "CallType" AS ENUM ('VOICE', 'VIDEO');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('RINGING', 'ACCEPTED', 'CONNECTED', 'ENDED', 'REJECTED', 'CANCELLED', 'MISSED', 'BUSY', 'FAILED');

-- CreateEnum
CREATE TYPE "CallEndReason" AS ENUM ('HANGUP', 'DECLINED', 'CANCELLED', 'TIMEOUT', 'BUSY', 'NETWORK', 'FAILED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'MISSED_CALL';

-- CreateTable
CREATE TABLE "calls" (
    "id" UUID NOT NULL,
    "callerId" UUID NOT NULL,
    "calleeId" UUID NOT NULL,
    "type" "CallType" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'RINGING',
    "zegoRoomId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "conversationId" UUID,
    "ringingExpiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedBy" UUID,
    "endReason" "CallEndReason",
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "calls_zegoRoomId_key" ON "calls"("zegoRoomId");

-- CreateIndex
CREATE INDEX "calls_callerId_createdAt_idx" ON "calls"("callerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "calls_calleeId_createdAt_idx" ON "calls"("calleeId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "calls_status_calleeId_idx" ON "calls"("status", "calleeId");

-- CreateIndex
CREATE INDEX "calls_status_callerId_idx" ON "calls"("status", "callerId");

-- CreateIndex
CREATE INDEX "calls_status_ringingExpiresAt_idx" ON "calls"("status", "ringingExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "calls_callerId_clientId_key" ON "calls"("callerId", "clientId");

