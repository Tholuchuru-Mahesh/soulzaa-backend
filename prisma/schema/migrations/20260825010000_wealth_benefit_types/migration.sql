-- Extend WealthBenefitType with the granular benefit categories from the
-- approved Wealth Level V1 benefits document (avatar rings, entrance
-- animations, theme slots, anonymous entry/gift, mic priority, etc.),
-- so Super Admin can categorize each benefit correctly instead of
-- collapsing everything into OTHER.

ALTER TYPE "WealthBenefitType" ADD VALUE 'AVATAR_RING';
ALTER TYPE "WealthBenefitType" ADD VALUE 'CHAT_HIGHLIGHT';
ALTER TYPE "WealthBenefitType" ADD VALUE 'PROFILE_THEME';
ALTER TYPE "WealthBenefitType" ADD VALUE 'ENTRANCE_ANIMATION';
ALTER TYPE "WealthBenefitType" ADD VALUE 'THEME_SLOTS';
ALTER TYPE "WealthBenefitType" ADD VALUE 'CUSTOM_GIFT_CREATOR';
ALTER TYPE "WealthBenefitType" ADD VALUE 'VISITOR_HISTORY';
ALTER TYPE "WealthBenefitType" ADD VALUE 'STICKER_PACK';
ALTER TYPE "WealthBenefitType" ADD VALUE 'ANONYMOUS_ENTRY';
ALTER TYPE "WealthBenefitType" ADD VALUE 'ANONYMOUS_GIFT';
ALTER TYPE "WealthBenefitType" ADD VALUE 'MIC_PRIORITY';
ALTER TYPE "WealthBenefitType" ADD VALUE 'VOICE_EFFECT';
ALTER TYPE "WealthBenefitType" ADD VALUE 'SUPPORT_PRIORITY';
ALTER TYPE "WealthBenefitType" ADD VALUE 'PROFILE_SHOWCASE';
ALTER TYPE "WealthBenefitType" ADD VALUE 'EVENT_ACCESS';
ALTER TYPE "WealthBenefitType" ADD VALUE 'VIP_HALL';
ALTER TYPE "WealthBenefitType" ADD VALUE 'RELATIONSHIP_MANAGER';
ALTER TYPE "WealthBenefitType" ADD VALUE 'FEATURE_ACCESS';
ALTER TYPE "WealthBenefitType" ADD VALUE 'RECOGNITION';
