-- AuditLog gains violationReason.
--
-- audit-log.service.ts already writes this optional field (moderation-action
-- context); the live dev database was missing the column even though the
-- schema and generated client already had it, breaking every AuditLog write
-- (device-change approvals, moderator provisioning, staff-IP changes, etc.)
-- with a P2022 "column does not exist" error.

ALTER TABLE "audit_logs" ADD COLUMN     "violationReason" TEXT;
