-- Admin identity & login telemetry (Phase 1).
--
-- Purely additive: one new column on users, four on session_history, and two new
-- tables. No data is modified or removed, and every addition is nullable or
-- defaulted, so existing rows remain valid.
--
--   users.isHiddenAccount      denormalised "holds a hidden staff role", so read
--                              paths filter on a boolean instead of resolving
--                              roles per request
--   session_history.browser/os/deviceType/country
--                              login telemetry derived at write time
--   admin_credentials          TOTP second-factor enrolment
--   admin_trusted_devices      known-device trust for the staff portal

-- AlterTable
ALTER TABLE "session_history" ADD COLUMN     "browser" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "deviceType" TEXT,
ADD COLUMN     "os" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "isHiddenAccount" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "admin_credentials" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "totpSecret" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_trusted_devices" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceHash" TEXT NOT NULL,
    "ipAddress" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_trusted_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_credentials_userId_key" ON "admin_credentials"("userId");

-- CreateIndex
CREATE INDEX "admin_trusted_devices_userId_idx" ON "admin_trusted_devices"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "admin_trusted_devices_userId_deviceHash_key" ON "admin_trusted_devices"("userId", "deviceHash");

-- CreateIndex
CREATE INDEX "users_isHiddenAccount_idx" ON "users"("isHiddenAccount");
