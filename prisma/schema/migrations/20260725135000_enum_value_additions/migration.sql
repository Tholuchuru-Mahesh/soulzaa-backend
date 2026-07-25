-- Enum value additions, split out of 20260725140000_treasury_and_enterprise_governance.
--
-- Prisma applies each migration file in a single transaction, and PostgreSQL
-- refuses to USE an enum value added by the same uncommitted transaction
-- (SQLSTATE 55P04, "unsafe use of new value of enum type"). The treasury
-- migration adds 'OFFLINE' to "RoomStatus" and then sets it as the default on
-- "audio_rooms"."status", so the two statements must live in separate
-- migrations. All bare ADD VALUE statements are hoisted here so they are
-- committed before anything downstream references them.

ALTER TYPE "AccountStatus" ADD VALUE 'INACTIVE';
ALTER TYPE "AccountStatus" ADD VALUE 'LOCKED';
ALTER TYPE "GiftContextType" ADD VALUE 'PK_BATTLE';
ALTER TYPE "GiftContextType" ADD VALUE 'MULTI_HOST_BATTLE';
ALTER TYPE "GiftContextType" ADD VALUE 'EVENT';
ALTER TYPE "GiftContextType" ADD VALUE 'GAME';
ALTER TYPE "VideoRoomInvitationStatus" ADD VALUE 'DELIVERED';
ALTER TYPE "VideoRoomInvitationStatus" ADD VALUE 'FAILED';
ALTER TYPE "VideoRoomSeatRequestStatus" ADD VALUE 'PROMOTED';
ALTER TYPE "VideoRoomSeatRequestStatus" ADD VALUE 'FAILED';
ALTER TYPE "WalletTxnReason" ADD VALUE 'HOST_EARNING';
ALTER TYPE "WalletTxnReason" ADD VALUE 'AGENCY_COMMISSION';
ALTER TYPE "WalletTxnReason" ADD VALUE 'COIN_SELLER_COMMISSION';
ALTER TYPE "WalletTxnReason" ADD VALUE 'WITHDRAWAL';
ALTER TYPE "WalletTxnReason" ADD VALUE 'VIP_RENEWAL';
ALTER TYPE "WalletTxnReason" ADD VALUE 'SYSTEM_TRANSFER';
ALTER TYPE "WalletTxnReason" ADD VALUE 'RESERVATION_HOLD';
ALTER TYPE "WalletTxnReason" ADD VALUE 'RESERVATION_RELEASE';
ALTER TYPE "WalletTxnReason" ADD VALUE 'RESERVATION_CONSUME';
ALTER TYPE "GiftTxnStatus" ADD VALUE 'FAILED';
ALTER TYPE "GiftType" ADD VALUE 'LIMITED_EDITION';
ALTER TYPE "RoomStatus" ADD VALUE 'OFFLINE';
