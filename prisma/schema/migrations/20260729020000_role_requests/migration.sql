-- Role approval chains. A request travels OFFICIAL → MANAGER → ADMIN and grants
-- a role on approval. Routing is by the normalised geography columns below.

CREATE TYPE "RoleRequestType" AS ENUM ('AGENCY', 'COIN_SELLER', 'MODERATOR', 'BUSINESS_DEVELOPMENT');
CREATE TYPE "RoleRequestStatus" AS ENUM ('SUBMITTED', 'IN_REVIEW', 'NEEDS_INFO', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED');
CREATE TYPE "RoleRequestStage" AS ENUM ('OFFICIAL', 'MANAGER', 'ADMIN');
CREATE TYPE "RoleRequestActionType" AS ENUM ('SUBMIT', 'ADVANCE', 'SEND_BACK', 'RESUBMIT', 'APPROVE', 'REJECT', 'WITHDRAW', 'CANCEL');

CREATE TABLE "role_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "reference" TEXT NOT NULL,
  "type" "RoleRequestType" NOT NULL,
  "subjectUserId" UUID NOT NULL,
  "initiatedByUserId" UUID NOT NULL,
  "status" "RoleRequestStatus" NOT NULL DEFAULT 'SUBMITTED',
  "currentStage" "RoleRequestStage",
  "currentStageEnteredAt" TIMESTAMP(3),
  "pipelineVersion" INTEGER NOT NULL,
  "formData" JSONB,
  "documentKeys" TEXT[],
  -- Routing geography. Region is required: every request enters at the region
  -- that owns it, and state/country are denormalised for the upward stages.
  "regionId" UUID NOT NULL,
  "stateId" UUID,
  "countryId" UUID,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  "decidedByUserId" UUID,
  "outcomeReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "role_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "role_requests_reference_key" ON "role_requests"("reference");
CREATE INDEX "role_requests_status_currentStage_idx" ON "role_requests"("status", "currentStage");
CREATE INDEX "role_requests_regionId_status_idx" ON "role_requests"("regionId", "status");
CREATE INDEX "role_requests_countryId_status_idx" ON "role_requests"("countryId", "status");
CREATE INDEX "role_requests_subjectUserId_type_idx" ON "role_requests"("subjectUserId", "type");

-- One OPEN request per (subject, type). A partial unique index rather than an
-- application check: two concurrent submits would both pass a SELECT-then-INSERT
-- and create duplicate chains for the same person.
CREATE UNIQUE INDEX "role_requests_one_open_per_subject_type"
  ON "role_requests"("subjectUserId", "type")
  WHERE "status" IN ('SUBMITTED', 'IN_REVIEW', 'NEEDS_INFO');

CREATE TABLE "role_request_actions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "requestId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "stage" "RoleRequestStage" NOT NULL,
  "action" "RoleRequestActionType" NOT NULL,
  "actorUserId" UUID NOT NULL,
  "actorRole" TEXT NOT NULL,
  "notes" TEXT,
  "checklistSnapshot" JSONB,
  "stageEnteredAt" TIMESTAMP(3) NOT NULL,
  "actedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "role_request_actions_pkey" PRIMARY KEY ("id")
);

-- Append-only: the sequence makes gaps and reordering detectable.
CREATE UNIQUE INDEX "role_request_actions_requestId_sequence_key" ON "role_request_actions"("requestId", "sequence");
CREATE INDEX "role_request_actions_requestId_actedAt_idx" ON "role_request_actions"("requestId", "actedAt");

ALTER TABLE "role_request_actions" ADD CONSTRAINT "role_request_actions_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "role_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "role_request_counters" (
  "year" INTEGER NOT NULL,
  "lastSequence" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "role_request_counters_pkey" PRIMARY KEY ("year")
);
