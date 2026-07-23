-- VR-12 PK Battle Engine (Video Rooms).
--
-- Fully additive: every new column carries a default or is nullable, and every
-- table is new, so this applies to a running instance with no backfill and no
-- downtime. The audio-room PK engine (pk_battles / PkStatus / PkMode / PkSide)
-- is untouched — see the header comment in video_rooms_pk.prisma for why the
-- two engines are deliberately NOT sharing tables.
--
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block in
-- PostgreSQL (before 12, this was a hard error; on 12+ the value exists but is
-- not visible/usable until the transaction that added it commits). Prisma
-- wraps each migration file in a single transaction by default, so these ten
-- statements are placed FIRST and no later statement in this file references
-- any of the new values. If this migration is ever actually applied and the
-- ALTER TYPE statements fail inside Prisma's transaction wrapper, split them
-- into their own migration directory with a `-- prisma-no-transaction`-style
-- marker (Prisma's mechanism for this is naming the file so migrate treats it
-- as non-transactional, e.g. via `prisma migrate resolve` / a dedicated
-- pre-migration) rather than trying to force them into this one. Not solved
-- here because this migration is authored only, not applied.
ALTER TYPE "WalletTxnReason" ADD VALUE IF NOT EXISTS 'PK_REWARD';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_INVITED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_INVITATION_ACCEPTED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_INVITATION_REJECTED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_STARTED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_PAUSED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_RESUMED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_ENDED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_RECOVERED';
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'PK_REWARD_DISTRIBUTED';

-- New enums.
CREATE TYPE "VideoRoomPkStatus" AS ENUM ('CREATED', 'INVITED', 'PENDING', 'ACCEPTED', 'COUNTDOWN', 'LIVE', 'PAUSED', 'RECOVERING', 'COMPLETED', 'CANCELLED', 'FAILED');
CREATE TYPE "VideoRoomPkMode" AS ENUM ('ONE_VS_ONE', 'TEAM');
CREATE TYPE "VideoRoomPkSide" AS ENUM ('RED', 'BLUE');
CREATE TYPE "VideoRoomPkInvitationStatus" AS ENUM ('SENT', 'DELIVERED', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "VideoRoomPkRewardKind" AS ENUM ('WINNER', 'PARTICIPATION', 'BONUS');

-- The aggregate root.
CREATE TABLE "video_room_pk_battles" (
  "id" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "mode" "VideoRoomPkMode" NOT NULL,
  "status" "VideoRoomPkStatus" NOT NULL DEFAULT 'CREATED',
  "createdBy" UUID NOT NULL,
  "countdownSeconds" INTEGER NOT NULL,
  "durationSeconds" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "pausedAt" TIMESTAMP(3),
  "totalPausedMs" INTEGER NOT NULL DEFAULT 0,
  "resumeSeq" INTEGER NOT NULL DEFAULT 0,
  "scoringSnapshot" JSONB NOT NULL,
  "rewardSnapshot" JSONB NOT NULL,
  "winningTeamId" UUID,
  "isDraw" BOOLEAN NOT NULL DEFAULT false,
  "completedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "video_room_pk_battles_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "video_room_pk_battles_roomId_status_idx" ON "video_room_pk_battles"("roomId", "status");
CREATE INDEX "video_room_pk_battles_status_endsAt_idx" ON "video_room_pk_battles"("status", "endsAt");

-- A side. The [battleId, side] unique keeps "exactly one RED, one BLUE" true
-- at the database while the service enforces "exactly 2 teams".
CREATE TABLE "video_room_pk_teams" (
  "id" UUID NOT NULL,
  "battleId" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "side" "VideoRoomPkSide" NOT NULL,
  "score" BIGINT NOT NULL DEFAULT 0,
  "giftCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "video_room_pk_teams_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "video_room_pk_teams_battleId_side_key" ON "video_room_pk_teams"("battleId", "side");
CREATE INDEX "video_room_pk_teams_battleId_idx" ON "video_room_pk_teams"("battleId");

CREATE TABLE "video_room_pk_participants" (
  "id" UUID NOT NULL,
  "battleId" UUID NOT NULL,
  "teamId" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "side" "VideoRoomPkSide" NOT NULL,
  "score" BIGINT NOT NULL DEFAULT 0,
  "giftCount" INTEGER NOT NULL DEFAULT 0,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "video_room_pk_participants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "video_room_pk_participants_battleId_userId_key" ON "video_room_pk_participants"("battleId", "userId");
CREATE INDEX "video_room_pk_participants_battleId_idx" ON "video_room_pk_participants"("battleId");

-- Per-invitee delivery record. `attempt` is what makes Retry replay-safe.
CREATE TABLE "video_room_pk_invitations" (
  "id" UUID NOT NULL,
  "battleId" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "targetRoomId" UUID NOT NULL,
  "inviteeUserId" UUID NOT NULL,
  "inviterUserId" UUID NOT NULL,
  "side" "VideoRoomPkSide" NOT NULL,
  "status" "VideoRoomPkInvitationStatus" NOT NULL DEFAULT 'SENT',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "deliveredAt" TIMESTAMP(3),
  "respondedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "video_room_pk_invitations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "video_room_pk_invitations_battleId_inviteeUserId_attempt_key" ON "video_room_pk_invitations"("battleId", "inviteeUserId", "attempt");
CREATE INDEX "video_room_pk_invitations_battleId_idx" ON "video_room_pk_invitations"("battleId");
CREATE INDEX "video_room_pk_invitations_inviteeUserId_status_idx" ON "video_room_pk_invitations"("inviteeUserId", "status");
CREATE INDEX "video_room_pk_invitations_status_expiresAt_idx" ON "video_room_pk_invitations"("status", "expiresAt");

-- Append-only scoring ledger. See the model doc comment in video_rooms_pk.prisma
-- for why both senderId and receiverId are stored (audio's equivalent only
-- keeps the receiver, making "top contributor" unanswerable).
CREATE TABLE "video_room_pk_contributions" (
  "id" UUID NOT NULL,
  "battleId" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "teamId" UUID NOT NULL,
  "participantId" UUID NOT NULL,
  "side" "VideoRoomPkSide" NOT NULL,
  "senderId" UUID NOT NULL,
  "receiverId" UUID NOT NULL,
  "baseAmount" BIGINT NOT NULL,
  "multiplierBps" INTEGER NOT NULL DEFAULT 10000,
  "scoredAmount" BIGINT NOT NULL,
  "giftTxnId" TEXT NOT NULL,
  "batchId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "video_room_pk_contributions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "video_room_pk_contributions_battleId_giftTxnId_participantId_key" ON "video_room_pk_contributions"("battleId", "giftTxnId", "participantId");
CREATE INDEX "video_room_pk_contributions_battleId_idx" ON "video_room_pk_contributions"("battleId");
CREATE INDEX "video_room_pk_contributions_participantId_idx" ON "video_room_pk_contributions"("participantId");

-- The mint-once guard: a replayed settlement hits battleId's uniqueness and
-- loads the existing row rather than minting a second pool.
CREATE TABLE "video_room_pk_reward_pools" (
  "id" UUID NOT NULL,
  "battleId" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "strategy" TEXT NOT NULL DEFAULT 'PERCENTAGE',
  "sourceAmount" BIGINT NOT NULL,
  "poolAmount" BIGINT NOT NULL,
  "winnerBps" INTEGER NOT NULL,
  "participationBps" INTEGER NOT NULL,
  "bonusBps" INTEGER NOT NULL,
  "allocatedAmount" BIGINT NOT NULL DEFAULT 0,
  "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "video_room_pk_reward_pools_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "video_room_pk_reward_pools_battleId_key" ON "video_room_pk_reward_pools"("battleId");
CREATE INDEX "video_room_pk_reward_pools_roomId_idx" ON "video_room_pk_reward_pools"("roomId");

-- One row per (battle, user, kind). The unique key fails a replayed payout
-- closed at the database, independently of the wallet's own idempotency key.
CREATE TABLE "video_room_pk_rewards" (
  "id" UUID NOT NULL,
  "battleId" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "teamId" UUID,
  "side" "VideoRoomPkSide",
  "kind" "VideoRoomPkRewardKind" NOT NULL,
  "amount" BIGINT NOT NULL,
  "currency" "WalletCurrency" NOT NULL,
  "walletTxnId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "video_room_pk_rewards_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "video_room_pk_rewards_idempotencyKey_key" ON "video_room_pk_rewards"("idempotencyKey");
CREATE UNIQUE INDEX "video_room_pk_rewards_battleId_userId_kind_key" ON "video_room_pk_rewards"("battleId", "userId", "kind");
CREATE INDEX "video_room_pk_rewards_battleId_idx" ON "video_room_pk_rewards"("battleId");
CREATE INDEX "video_room_pk_rewards_userId_idx" ON "video_room_pk_rewards"("userId");

-- THE duplicate-PK gate. Prisma cannot express a partial unique index, so it is
-- authored here by hand. This is the enforcement; the service pre-check exists
-- only to return a clean DuplicatePKException instead of a raw 23505.
CREATE UNIQUE INDEX "video_room_pk_battles_one_active_per_room"
  ON "video_room_pk_battles" ("roomId")
  WHERE "status" NOT IN ('COMPLETED', 'CANCELLED', 'FAILED');
