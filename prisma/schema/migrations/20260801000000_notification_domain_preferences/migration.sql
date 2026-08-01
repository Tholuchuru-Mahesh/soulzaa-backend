-- Per-category delivery switches for the domain notification producers
-- (wallet, games, VIP, family).
--
-- Every column defaults to true. An absent or default row must mean "tell me",
-- never "stay silent": a user who has never opened Settings still needs to hear
-- that their recharge landed. This mirrors the VR-15 columns added in
-- 20260723000000_vr15_notification_integration.
--
-- Each one is gated by exactly one PushCategory in the notification module's
-- PushPolicy (CATEGORY_SWITCH). That map is typed Record<PushCategory, ...>, so
-- adding a category without a switch here fails to compile.

ALTER TABLE "notification_preferences"
  ADD COLUMN IF NOT EXISTS "walletEvents" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "gameEvents" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "vipEvents" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "familyEvents" BOOLEAN NOT NULL DEFAULT true;
