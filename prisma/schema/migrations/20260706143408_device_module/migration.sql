-- CreateEnum
CREATE TYPE "DeviceEventType" AS ENUM ('REGISTERED', 'VERIFIED', 'REMOVED', 'TRUSTED', 'UNTRUSTED', 'SUSPICIOUS_LOGIN', 'PUSH_TOKEN_UPDATED', 'RENAMED');

-- AlterTable
ALTER TABLE "user_devices" ADD COLUMN     "appVersion" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deviceName" TEXT,
ADD COLUMN     "deviceType" TEXT,
ADD COLUMN     "ipAddress" TEXT,
ADD COLUMN     "osVersion" TEXT,
ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "trusted_devices" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "trustedByIp" TEXT,
    "trustedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "trusted_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_history" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" UUID,
    "event" "DeviceEventType" NOT NULL,
    "ip" TEXT,
    "country" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trusted_devices_deviceId_key" ON "trusted_devices"("deviceId");

-- CreateIndex
CREATE INDEX "trusted_devices_userId_idx" ON "trusted_devices"("userId");

-- CreateIndex
CREATE INDEX "device_history_userId_idx" ON "device_history"("userId");

-- CreateIndex
CREATE INDEX "device_history_deviceId_idx" ON "device_history"("deviceId");
