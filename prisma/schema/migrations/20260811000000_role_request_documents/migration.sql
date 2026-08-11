-- Per-document tracking for role requests.
--
-- `role_requests.documentKeys` is a flat TEXT[] — it cannot say which key is the
-- PAN card and has nowhere to hold a verdict, so a reviewer opening a request saw
-- an unlabelled list of URLs. This table gives every upload its slot, its
-- automated check result and its own accept/reject decision. The old column is
-- left in place and still mirrored on write; nothing new should read it.

CREATE TYPE "RoleRequestDocumentSlot" AS ENUM ('AADHAAR', 'PAN', 'ADDRESS_PROOF', 'BUSINESS_PROOF', 'BANK_DETAILS', 'PROFILE_PHOTO');
CREATE TYPE "RoleRequestDocumentStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');
CREATE TYPE "DocumentCheckVerdict" AS ENUM ('PASSED', 'SUSPECT', 'FAILED');

CREATE TABLE "role_request_documents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "requestId" UUID NOT NULL,
  "slot" "RoleRequestDocumentSlot" NOT NULL,
  "storageKey" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  -- SHA-256 of the stored bytes, computed server-side from S3 rather than
  -- trusted from the client.
  "checksum" TEXT NOT NULL,
  "checkVerdict" "DocumentCheckVerdict" NOT NULL,
  "checkFindings" JSONB,
  "status" "RoleRequestDocumentStatus" NOT NULL DEFAULT 'PENDING',
  "reviewNotes" TEXT,
  "reviewedByUserId" UUID,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "role_request_documents_pkey" PRIMARY KEY ("id")
);

-- One document per slot per request; a re-upload replaces rather than accumulates.
CREATE UNIQUE INDEX "role_request_documents_requestId_slot_key" ON "role_request_documents"("requestId", "slot");

-- Deliberately NOT unique. One applicant may legitimately use the same scan for
-- two slots; what matters is the same file appearing under *different* applicants,
-- which the verifier detects with a lookup on this index.
CREATE INDEX "role_request_documents_checksum_idx" ON "role_request_documents"("checksum");

ALTER TABLE "role_request_documents" ADD CONSTRAINT "role_request_documents_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "role_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
