-- AlterEnum
-- Adding several values to an enum in one migration requires PostgreSQL 12+.
-- Production runs 16 (docker-compose.prod.yml), so this is safe as written.
ALTER TYPE "NotificationType" ADD VALUE 'SUPPORT_TICKET_REPLY';
ALTER TYPE "NotificationType" ADD VALUE 'SUPPORT_TICKET_RESOLVED';
ALTER TYPE "NotificationType" ADD VALUE 'SUPPORT_TICKET_USER_REPLY';
