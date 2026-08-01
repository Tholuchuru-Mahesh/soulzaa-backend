-- NotificationType values for the domain notification producers
-- (wallet, games, VIP, family, security).
--
-- Bare ADD VALUE statements, in their own migration and nothing else, for the
-- reason recorded in 20260725135000_enum_value_additions: Prisma applies each
-- migration in a single transaction, and PostgreSQL refuses to USE an enum
-- value added by the same uncommitted transaction (SQLSTATE 55P04, "unsafe use
-- of new value of enum type"). Keeping these alone guarantees they are
-- committed before anything can reference them.
--
-- IF NOT EXISTS makes the migration re-runnable, which matters because
-- `prisma migrate deploy` runs on every container start (see Dockerfile CMD).

-- Wallet
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RECHARGE_SUCCESS';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REFUND_PROCESSED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'COINS_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'COINS_DEDUCTED';

-- Games
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GAME_MATCH_FOUND';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GAME_STARTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GAME_WON';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GAME_LOST';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GAME_OPPONENT_LEFT';

-- VIP
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VIP_ACTIVATED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VIP_RENEWED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VIP_EXPIRING';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VIP_EXPIRED';

-- Family
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'FAMILY_MEMBER_JOINED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'FAMILY_MEMBER_LEFT';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'FAMILY_REMOVED';

-- Security
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SECURITY_NEW_LOGIN';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SECURITY_PASSWORD_CHANGED';
