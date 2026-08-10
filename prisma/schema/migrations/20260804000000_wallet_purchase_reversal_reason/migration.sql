-- WalletTxnReason gains PURCHASE_REVERSAL.
--
-- Coins reversed because Google Play voided the purchase that created them
-- (GoogleRtdnService -> WalletTransactionService.reverseWallet). Kept distinct
-- from ADMIN_DEBIT so refund losses stay separable in reporting, and enforced:
-- reverseWallet rejects every reason except this one.
--
-- A bare ADD VALUE, alone in its own migration, for the reason recorded in
-- 20260725135000_enum_value_additions: Prisma applies each migration in a single
-- transaction, and PostgreSQL refuses to USE an enum value added by the same
-- uncommitted transaction (SQLSTATE 55P04, "unsafe use of new value of enum
-- type"). Keeping it alone guarantees it is committed before the application
-- code that writes it can run.
--
-- IF NOT EXISTS makes the migration re-runnable, which matters because
-- `prisma migrate deploy` runs on every container start (see Dockerfile CMD).

ALTER TYPE "WalletTxnReason" ADD VALUE IF NOT EXISTS 'PURCHASE_REVERSAL';
