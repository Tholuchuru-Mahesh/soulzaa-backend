-- CreateEnum
CREATE TYPE "GameCode" AS ENUM ('GREEDY', 'ROULETTE', 'SLOTS', 'JACKPOT', 'UNO', 'LUDO', 'CARROM', 'DOMINO');

-- CreateEnum
CREATE TYPE "GameCategory" AS ENUM ('PREMIUM', 'CASUAL');

-- CreateEnum
CREATE TYPE "GameCurrency" AS ENUM ('GOLD', 'FREE');

-- CreateEnum
CREATE TYPE "GameLobbyStatus" AS ENUM ('OPEN', 'STARTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "GameSessionStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED', 'ABORTED');

-- CreateEnum
CREATE TYPE "GameParticipantStatus" AS ENUM ('PLAYING', 'WON', 'LOST', 'DREW', 'REFUNDED');

-- CreateEnum
CREATE TYPE "GameTxnType" AS ENUM ('STAKE', 'PAYOUT', 'REFUND');

-- AlterEnum
ALTER TYPE "WalletTxnReason" ADD VALUE 'GAME_REFUND';

-- CreateTable
CREATE TABLE "game_definitions" (
    "id" UUID NOT NULL,
    "code" "GameCode" NOT NULL,
    "name" TEXT NOT NULL,
    "category" "GameCategory" NOT NULL,
    "currency" "GameCurrency" NOT NULL,
    "minPlayers" INTEGER NOT NULL,
    "maxPlayers" INTEGER NOT NULL,
    "minStake" BIGINT NOT NULL,
    "maxStake" BIGINT NOT NULL,
    "houseRakeBps" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,

    CONSTRAINT "game_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_lobbies" (
    "id" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "hostId" UUID NOT NULL,
    "roomId" UUID,
    "category" "GameCategory" NOT NULL,
    "currency" "GameCurrency" NOT NULL,
    "stake" BIGINT NOT NULL,
    "maxPlayers" INTEGER NOT NULL,
    "status" "GameLobbyStatus" NOT NULL DEFAULT 'OPEN',
    "sessionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdBy" UUID,
    "updatedBy" UUID,

    CONSTRAINT "game_lobbies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_lobby_members" (
    "id" UUID NOT NULL,
    "lobbyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_lobby_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_sessions" (
    "id" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "code" "GameCode" NOT NULL,
    "lobbyId" UUID,
    "joinCode" TEXT NOT NULL,
    "hostId" UUID NOT NULL,
    "roomId" UUID,
    "category" "GameCategory" NOT NULL,
    "currency" "GameCurrency" NOT NULL,
    "stake" BIGINT NOT NULL,
    "playerCount" INTEGER NOT NULL,
    "potAmount" BIGINT NOT NULL DEFAULT 0,
    "status" "GameSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "createdBy" UUID,
    "updatedBy" UUID,

    CONSTRAINT "game_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_participants" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "stake" BIGINT NOT NULL,
    "stakeTxnId" UUID,
    "status" "GameParticipantStatus" NOT NULL DEFAULT 'PLAYING',
    "payoutAmount" BIGINT NOT NULL DEFAULT 0,
    "payoutTxnId" UUID,
    "refundTxnId" UUID,
    "isWinner" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "game_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_transactions" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "participantId" UUID,
    "userId" UUID NOT NULL,
    "type" "GameTxnType" NOT NULL,
    "currency" "GameCurrency" NOT NULL,
    "amount" BIGINT NOT NULL,
    "walletTxnId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_match_results" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "code" "GameCode" NOT NULL,
    "potAmount" BIGINT NOT NULL,
    "payoutTotal" BIGINT NOT NULL,
    "rakeAmount" BIGINT NOT NULL,
    "winners" UUID[],
    "resultData" JSONB NOT NULL,
    "settledBy" UUID,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_match_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_event_logs" (
    "id" UUID NOT NULL,
    "sessionId" UUID,
    "lobbyId" UUID,
    "userId" UUID,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_event_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "game_definitions_code_key" ON "game_definitions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "game_lobbies_code_key" ON "game_lobbies"("code");

-- CreateIndex
CREATE INDEX "game_lobbies_status_expiresAt_idx" ON "game_lobbies"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "game_lobbies_definitionId_status_idx" ON "game_lobbies"("definitionId", "status");

-- CreateIndex
CREATE INDEX "game_lobbies_hostId_idx" ON "game_lobbies"("hostId");

-- CreateIndex
CREATE INDEX "game_lobby_members_lobbyId_idx" ON "game_lobby_members"("lobbyId");

-- CreateIndex
CREATE UNIQUE INDEX "game_lobby_members_lobbyId_userId_key" ON "game_lobby_members"("lobbyId", "userId");

-- CreateIndex
CREATE INDEX "game_sessions_status_idx" ON "game_sessions"("status");

-- CreateIndex
CREATE INDEX "game_sessions_definitionId_status_idx" ON "game_sessions"("definitionId", "status");

-- CreateIndex
CREATE INDEX "game_sessions_roomId_idx" ON "game_sessions"("roomId");

-- CreateIndex
CREATE INDEX "game_sessions_hostId_idx" ON "game_sessions"("hostId");

-- CreateIndex
CREATE INDEX "game_sessions_status_startedAt_idx" ON "game_sessions"("status", "startedAt");

-- CreateIndex
CREATE INDEX "game_participants_sessionId_idx" ON "game_participants"("sessionId");

-- CreateIndex
CREATE INDEX "game_participants_userId_idx" ON "game_participants"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "game_participants_sessionId_userId_key" ON "game_participants"("sessionId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "game_transactions_idempotencyKey_key" ON "game_transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "game_transactions_sessionId_idx" ON "game_transactions"("sessionId");

-- CreateIndex
CREATE INDEX "game_transactions_userId_createdAt_idx" ON "game_transactions"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "game_match_results_sessionId_key" ON "game_match_results"("sessionId");

-- CreateIndex
CREATE INDEX "game_match_results_definitionId_settledAt_idx" ON "game_match_results"("definitionId", "settledAt");

-- CreateIndex
CREATE INDEX "game_event_logs_sessionId_idx" ON "game_event_logs"("sessionId");

-- CreateIndex
CREATE INDEX "game_event_logs_action_createdAt_idx" ON "game_event_logs"("action", "createdAt");
