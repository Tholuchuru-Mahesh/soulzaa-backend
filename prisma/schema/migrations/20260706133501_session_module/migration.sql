-- CreateEnum
CREATE TYPE "SessionEventType" AS ENUM ('CREATED', 'REFRESHED', 'REVOKED', 'EXPIRED', 'LOGGED_OUT', 'HIJACK_DETECTED', 'ADMIN_LOGOUT', 'CONCURRENT_EVICTED');

-- AlterTable
ALTER TABLE "user_devices" ADD COLUMN     "trusted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trustedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "user_sessions" ADD COLUMN     "platform" "DevicePlatform";

-- CreateTable
CREATE TABLE "session_history" (
    "id" UUID NOT NULL,
    "sessionId" UUID,
    "userId" UUID NOT NULL,
    "event" "SessionEventType" NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "session_history_userId_idx" ON "session_history"("userId");

-- CreateIndex
CREATE INDEX "session_history_sessionId_idx" ON "session_history"("sessionId");
