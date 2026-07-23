-- VR-11 Treasure Box Engine (Video Rooms).
--
-- Fully additive: every column is new or defaulted and every table is new, so
-- this applies to a running instance with no backfill and no downtime. The
-- audio-room treasure engine reads none of the new objects.
--
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block in
-- PostgreSQL < 12. On 12+ it can, but the new value is not usable in the same
-- transaction. Prisma runs each migration file in one transaction, so the enum
-- additions are split into their own statements and no later statement in this
-- file references the new values.

ALTER TYPE "TreasureSessionStatus" ADD VALUE IF NOT EXISTS 'DRAFT';
ALTER TYPE "TreasureSessionStatus" ADD VALUE IF NOT EXISTS 'PAUSED';
ALTER TYPE "TreasureSessionStatus" ADD VALUE IF NOT EXISTS 'CLOSED';
ALTER TYPE "TreasureSessionStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';
ALTER TYPE "TreasureBoxStatus"     ADD VALUE IF NOT EXISTS 'UNLOCKING';

CREATE TYPE "TreasureRewardStatus" AS ENUM ('PENDING', 'DISTRIBUTED', 'FAILED');

-- Default DISTRIBUTED keeps every existing row semantically correct: a
-- treasure_rewards row has only ever been written after a successful payout.
ALTER TABLE "treasure_rewards"
  ADD COLUMN "status"        "TreasureRewardStatus" NOT NULL DEFAULT 'DISTRIBUTED',
  ADD COLUMN "attempts"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastError"     TEXT,
  ADD COLUMN "failureStage"  TEXT,
  ADD COLUMN "distributedAt" TIMESTAMP(3);

CREATE TABLE "video_room_treasure_levels" (
  "id" UUID NOT NULL,
  "level" INTEGER NOT NULL,
  "threshold" BIGINT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "poolStrategy" TEXT NOT NULL DEFAULT 'PERCENTAGE',
  "poolPercentBps" INTEGER NOT NULL DEFAULT 1000,
  "poolFixedAmount" BIGINT,
  "winnerAlgorithm" TEXT NOT NULL DEFAULT 'RANDOM',
  "winnerCount" INTEGER NOT NULL DEFAULT 3,
  "minStaySeconds" INTEGER NOT NULL DEFAULT 120,
  "minActivityEvents" INTEGER NOT NULL DEFAULT 0,
  "createdBy" UUID,
  "updatedBy" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "video_room_treasure_levels_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "video_room_treasure_levels_level_key"
  ON "video_room_treasure_levels"("level");

CREATE TABLE "video_room_treasure_sessions" (
  "id" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "levelSnapshot" JSONB NOT NULL,
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "video_room_treasure_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "video_room_treasure_sessions_sessionId_key"
  ON "video_room_treasure_sessions"("sessionId");
CREATE INDEX "video_room_treasure_sessions_roomId_idx"
  ON "video_room_treasure_sessions"("roomId");

CREATE TABLE "treasure_reward_pools" (
  "id" UUID NOT NULL,
  "boxId" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "level" INTEGER NOT NULL,
  "strategy" TEXT NOT NULL,
  "sourceAmount" BIGINT NOT NULL,
  "poolAmount" BIGINT NOT NULL,
  "allocatedAmount" BIGINT NOT NULL DEFAULT 0,
  "winnerCount" INTEGER NOT NULL,
  "algorithm" TEXT NOT NULL,
  "algorithmVersion" INTEGER NOT NULL DEFAULT 1,
  "selectionSeed" TEXT NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "treasure_reward_pools_pkey" PRIMARY KEY ("id")
);
-- The replay guard: a retried unlock job fails closed here rather than minting twice.
CREATE UNIQUE INDEX "treasure_reward_pools_boxId_key" ON "treasure_reward_pools"("boxId");
CREATE INDEX "treasure_reward_pools_roomId_idx" ON "treasure_reward_pools"("roomId");
CREATE INDEX "treasure_reward_pools_sessionId_idx" ON "treasure_reward_pools"("sessionId");

CREATE TABLE "treasure_winners" (
  "id" UUID NOT NULL,
  "boxId" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "algorithm" TEXT NOT NULL,
  "shareBps" INTEGER NOT NULL,
  "amount" BIGINT NOT NULL,
  "eligibleCount" INTEGER NOT NULL,
  "candidateCount" INTEGER NOT NULL,
  "selectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "treasure_winners_pkey" PRIMARY KEY ("id")
);
-- One win per user per box, enforced by the database rather than by
-- application code across a retrying queue.
CREATE UNIQUE INDEX "treasure_winners_boxId_userId_key" ON "treasure_winners"("boxId", "userId");
CREATE INDEX "treasure_winners_roomId_idx" ON "treasure_winners"("roomId");
CREATE INDEX "treasure_winners_userId_idx" ON "treasure_winners"("userId");
