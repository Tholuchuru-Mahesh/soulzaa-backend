-- VR-13: video room ranking snapshots, materialised leaderboards, aggregation log.
--
-- Generated verbatim from `prisma migrate diff --from-empty --to-schema-datamodel
-- prisma/schema --script`, filtered to the three tables owned by this migration.
-- Identifiers are Prisma's own computed (and, where needed, truncated) names —
-- do not hand-edit index/constraint names here; regenerate via the same
-- `migrate diff` command instead so this file always matches what Prisma
-- believes the database looks like.

-- CreateTable
CREATE TABLE "video_room_ranking_snapshots" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" BIGINT NOT NULL,
    "metrics" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_room_ranking_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_leaderboard_snapshots" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "entries" JSONB NOT NULL,
    "totalEntries" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_room_leaderboard_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_room_ranking_aggregation_logs" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "sourceRows" INTEGER NOT NULL DEFAULT 0,
    "entriesWritten" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "video_room_ranking_aggregation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_room_ranking_snapshots_scope_dimension_period_dateKey_idx" ON "video_room_ranking_snapshots"("scope", "dimension", "period", "dateKey", "rank");

-- CreateIndex
CREATE INDEX "video_room_ranking_snapshots_targetId_dimension_period_idx" ON "video_room_ranking_snapshots"("targetId", "dimension", "period");

-- CreateIndex
CREATE INDEX "video_room_ranking_snapshots_period_createdAt_idx" ON "video_room_ranking_snapshots"("period", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "video_room_ranking_snapshots_scope_dimension_period_dateKey_key" ON "video_room_ranking_snapshots"("scope", "dimension", "period", "dateKey", "targetId");

-- CreateIndex
CREATE INDEX "video_room_leaderboard_snapshots_scope_dimension_period_cap_idx" ON "video_room_leaderboard_snapshots"("scope", "dimension", "period", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "video_room_leaderboard_snapshots_scope_dimension_period_dat_key" ON "video_room_leaderboard_snapshots"("scope", "dimension", "period", "dateKey");

-- CreateIndex
CREATE INDEX "video_room_ranking_aggregation_logs_status_startedAt_idx" ON "video_room_ranking_aggregation_logs"("status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "video_room_ranking_aggregation_logs_scope_dimension_period__key" ON "video_room_ranking_aggregation_logs"("scope", "dimension", "period", "dateKey");
