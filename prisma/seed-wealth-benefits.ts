/**
 * Seeds the Wealth Level V1 cumulative benefits (and the 3 documented reward
 * *names*) per the approved Wealth Level V1 document. Idempotent: skips any
 * level that already has benefit/reward rows, so it's safe to re-run.
 *
 * Levels 0-12 are NOT created here — they already exist (WealthLevel is
 * seeded separately). This only populates WealthLevelBenefit/WealthLevelReward.
 *
 * Rewards: the V1 document names exactly three rewards (Welcome Reward @
 * Prestige, Weekly Reward @ Rise, Exclusive Monthly Rewards @ Celestial) but
 * specifies no amount/value for any of them. Per the explicit instruction
 * not to invent reward amounts, these three are seeded `isActive: false` —
 * present in Super Admin as configurable placeholders, never shown as live/
 * claimable in the app until a real value is configured.
 */
import {
  CosmeticRarity,
  CosmeticType,
  PrismaClient,
  WealthBenefitType,
  WealthRewardFrequency,
  WealthRewardGrantType,
  WealthRewardType,
} from '@prisma/client';

const prisma = new PrismaClient();

/** Mirrors WealthBenefitService's EQUIP_TYPE_MAP — which benefit types back
 * a real Backpack/Cosmetics catalog entry (so they can actually be equipped
 * and show up wherever the Backpack already renders equipped cosmetics). */
const EQUIP_TYPE_MAP: Partial<Record<WealthBenefitType, CosmeticType>> = {
  [WealthBenefitType.BADGE]: CosmeticType.BADGE,
  [WealthBenefitType.PROFILE_FRAME]: CosmeticType.FRAME,
  [WealthBenefitType.AVATAR_RING]: CosmeticType.DECORATION,
  [WealthBenefitType.AVATAR_EFFECT]: CosmeticType.DECORATION,
  [WealthBenefitType.THEME]: CosmeticType.THEME,
  [WealthBenefitType.PROFILE_THEME]: CosmeticType.THEME,
};

/** Get-or-create a catalog cosmetic by (type, name), mirroring
 * ICosmeticsService.ensureCosmetic's semantics (this seed runs standalone,
 * outside Nest's DI, so it upserts directly rather than bootstrapping the app). */
async function ensureCosmetic(type: CosmeticType, name: string): Promise<string> {
  const cosmetic = await prisma.cosmetic.upsert({
    where: { type_name: { type, name } },
    update: {},
    create: { type, name, rarity: CosmeticRarity.COMMON, enabled: true, transferable: false },
  });
  return cosmetic.id;
}

interface BenefitSeed {
  type: WealthBenefitType;
  name: string;
  config?: Record<string, unknown>;
}

interface RewardSeed {
  name: string;
  description: string;
  frequency: WealthRewardFrequency;
}

const BENEFITS: Record<number, BenefitSeed[]> = {
  // Level 0 (Normal User) intentionally has no benefit rows — it is the
  // baseline (standard profile/chat/audio-room experience), not a perk.
  1: [
    { type: WealthBenefitType.BADGE, name: 'Prestige Badge' },
    { type: WealthBenefitType.PROFILE_FRAME, name: 'Premium Profile Frame' },
    { type: WealthBenefitType.FEATURE_ACCESS, name: 'Wealth Level Display' },
  ],
  2: [
    { type: WealthBenefitType.AVATAR_RING, name: 'Avatar Ring' },
    { type: WealthBenefitType.CHAT_BUBBLE, name: 'Premium Chat Bubble' },
    { type: WealthBenefitType.THEME_SLOTS, name: 'Audio Room Theme Slots', config: { value: 2 } },
  ],
  3: [
    { type: WealthBenefitType.BADGE, name: 'Animated Badge', config: { animated: true } },
    { type: WealthBenefitType.AVATAR_RING, name: 'Animated Avatar Ring', config: { animated: true } },
    { type: WealthBenefitType.CHAT_BUBBLE, name: 'Animated Chat Bubble', config: { animated: true } },
    { type: WealthBenefitType.THEME_SLOTS, name: 'Audio Room Theme Slots', config: { value: 4 } },
    { type: WealthBenefitType.VISITOR_HISTORY, name: 'Profile Visitor History' },
    { type: WealthBenefitType.CUSTOM_GIFT_CREATOR, name: 'Basic Custom Gift Creator', config: { tier: 'basic' } },
  ],
  4: [
    { type: WealthBenefitType.PROFILE_STYLE, name: 'Name Glow Effect' },
    { type: WealthBenefitType.ENTRANCE_ANIMATION, name: 'Entrance Animation' },
    { type: WealthBenefitType.PROFILE_THEME, name: 'Premium Profile Theme' },
    { type: WealthBenefitType.GIFT_EFFECT, name: 'Gift Combo Effects' },
    { type: WealthBenefitType.THEME_SLOTS, name: 'Audio Room Theme Slots', config: { value: 6 } },
    { type: WealthBenefitType.STICKER_PACK, name: 'VIP Sticker Pack' },
    { type: WealthBenefitType.CHAT_HIGHLIGHT, name: 'Highlighted Chat Messages' },
  ],
  5: [
    { type: WealthBenefitType.ENTRANCE_ANIMATION, name: 'Royal Entrance Animation' },
    { type: WealthBenefitType.PROFILE_THEME, name: 'Royal Profile Theme' },
    { type: WealthBenefitType.AVATAR_EFFECT, name: 'Royal Avatar Aura' },
    { type: WealthBenefitType.PROFILE_STYLE, name: 'Animated Profile Card' },
    { type: WealthBenefitType.THEME_SLOTS, name: 'Audio Room Theme Slots', config: { value: 8 } },
    { type: WealthBenefitType.CUSTOM_GIFT_CREATOR, name: 'Advanced Custom Gift Creator', config: { tier: 'advanced' } },
    { type: WealthBenefitType.CHAT_EFFECT, name: 'Flying Comments' },
    { type: WealthBenefitType.FEATURE_ACCESS, name: 'Lucky Treasure Access' },
  ],
  6: [
    { type: WealthBenefitType.BADGE, name: 'Crown Medal' },
    { type: WealthBenefitType.ENTRANCE_ANIMATION, name: 'Crown Entrance Effect' },
    { type: WealthBenefitType.ANONYMOUS_ENTRY, name: 'Anonymous Room Entry' },
    { type: WealthBenefitType.ANONYMOUS_GIFT, name: 'Anonymous Gift Sending' },
    { type: WealthBenefitType.THEME_SLOTS, name: 'Audio Room Theme Slots', config: { value: 12 } },
    { type: WealthBenefitType.MIC_PRIORITY, name: 'Priority Mic Queue' },
    { type: WealthBenefitType.VOICE_EFFECT, name: 'Voice Effect Pack' },
    { type: WealthBenefitType.FEATURE_ACCESS, name: 'Creator Interaction Priority' },
  ],
  7: [
    { type: WealthBenefitType.ANIMATION, name: 'Legend Name Animation' },
    { type: WealthBenefitType.OTHER, name: 'Legend Mount' },
    { type: WealthBenefitType.PROFILE_THEME, name: 'Custom Profile Background' },
    { type: WealthBenefitType.CHAT_EFFECT, name: 'Premium Message Style' },
    { type: WealthBenefitType.THEME_SLOTS, name: 'Audio Room Theme Slots', config: { value: 15 } },
    { type: WealthBenefitType.FEATURE_ACCESS, name: 'Reserved VIP Seat' },
    { type: WealthBenefitType.SUPPORT_PRIORITY, name: 'Priority Customer Support' },
    { type: WealthBenefitType.PROFILE_SHOWCASE, name: 'Profile Showcase' },
  ],
  8: [
    { type: WealthBenefitType.BADGE, name: 'Titan Crown' },
    { type: WealthBenefitType.AVATAR_EFFECT, name: 'Titan Avatar Aura' },
    { type: WealthBenefitType.ENTRANCE_ANIMATION, name: 'Titan Entrance Animation' },
    { type: WealthBenefitType.THEME_SLOTS, name: 'Audio Room Theme Slots', config: { value: 18 } },
    { type: WealthBenefitType.GIFT_EFFECT, name: 'Royal Gift Collection' },
    { type: WealthBenefitType.ANIMATION, name: 'Birthday Celebration Animation' },
    { type: WealthBenefitType.FEATURE_ACCESS, name: 'Creator Priority Reply' },
    { type: WealthBenefitType.PROFILE_SHOWCASE, name: 'Featured Profile' },
  ],
  9: [
    { type: WealthBenefitType.PROFILE_FRAME, name: 'Supreme Dynamic Frame', config: { dynamic: true } },
    { type: WealthBenefitType.PROFILE_THEME, name: 'Supreme Dynamic Theme', config: { dynamic: true } },
    { type: WealthBenefitType.OTHER, name: 'Letter ID' },
    { type: WealthBenefitType.PROFILE_STYLE, name: 'Exclusive Profile Banner' },
    { type: WealthBenefitType.THEME_SLOTS, name: 'Audio Room Theme Slots', config: { value: 20 } },
    { type: WealthBenefitType.CUSTOM_GIFT_CREATOR, name: 'Advanced Custom Gift Creator', config: { tier: 'advanced' } },
    { type: WealthBenefitType.SUPPORT_PRIORITY, name: 'Dedicated VIP Support' },
  ],
  10: [
    { type: WealthBenefitType.BADGE, name: 'Infinity Crown' },
    { type: WealthBenefitType.AVATAR_EFFECT, name: 'Infinity Avatar Aura' },
    { type: WealthBenefitType.PROFILE_STYLE, name: 'Infinity Profile Card' },
    { type: WealthBenefitType.CHAT_EFFECT, name: 'Luxury Chat Theme' },
    { type: WealthBenefitType.THEME_SLOTS, name: 'Audio Room Theme Slots', config: { value: 25 } },
    { type: WealthBenefitType.EVENT_ACCESS, name: 'Exclusive Event Invitations' },
    { type: WealthBenefitType.PROFILE_SHOWCASE, name: 'Premium Profile Showcase' },
    { type: WealthBenefitType.EVENT_ACCESS, name: 'VIP Event Access' },
  ],
  11: [
    { type: WealthBenefitType.ENTRANCE_ANIMATION, name: 'Celestial Entrance Animation' },
    { type: WealthBenefitType.PROFILE_THEME, name: 'Celestial Theme' },
    { type: WealthBenefitType.PROFILE_THEME, name: 'Celestial Dynamic Background', config: { dynamic: true } },
    { type: WealthBenefitType.THEME_SLOTS, name: 'Audio Room Theme Slots', config: { value: 30 } },
    { type: WealthBenefitType.GIFT_EFFECT, name: 'Celestial Gift Collection' },
    { type: WealthBenefitType.RELATIONSHIP_MANAGER, name: 'Relationship Manager' },
    { type: WealthBenefitType.VIP_HALL, name: 'VIP Hall Access' },
  ],
  12: [
    { type: WealthBenefitType.BADGE, name: 'Immortal Crown' },
    { type: WealthBenefitType.BADGE, name: 'Immortal Dynamic Badge', config: { dynamic: true } },
    { type: WealthBenefitType.PROFILE_FRAME, name: 'Immortal Animated Frame', config: { animated: true } },
    { type: WealthBenefitType.AVATAR_EFFECT, name: 'Immortal Avatar Aura' },
    { type: WealthBenefitType.ENTRANCE_ANIMATION, name: 'Immortal Entrance Animation' },
    { type: WealthBenefitType.PROFILE_THEME, name: 'Immortal Profile Theme' },
    { type: WealthBenefitType.PROFILE_STYLE, name: 'Immortal Profile Card' },
    { type: WealthBenefitType.THEME_SLOTS, name: 'Audio Room Theme Slots', config: { value: 40 } },
    { type: WealthBenefitType.CUSTOM_GIFT_CREATOR, name: 'Unlimited Custom Gift Templates', config: { tier: 'unlimited' } },
    { type: WealthBenefitType.RECOGNITION, name: 'Hall of Fame Recognition' },
    { type: WealthBenefitType.FEATURE_ACCESS, name: 'First Access to New Features' },
    { type: WealthBenefitType.EVENT_ACCESS, name: 'Invitation-only Soulzaaa Events' },
    { type: WealthBenefitType.RECOGNITION, name: 'Lifetime Recognition During Active Level' },
  ],
};

// Only the three rewards the V1 document actually names. No amount/value is
// specified for any of them, so they are seeded inactive — configurable
// placeholders for Super Admin, never fabricated live rewards.
const REWARDS: Record<number, RewardSeed[]> = {
  1: [{ name: 'Welcome Reward', description: 'Granted once on reaching Prestige.', frequency: WealthRewardFrequency.ONE_TIME }],
  2: [{ name: 'Weekly Reward', description: 'Recurring weekly reward for Rise and above.', frequency: WealthRewardFrequency.WEEKLY }],
  11: [{ name: 'Exclusive Monthly Rewards', description: 'Recurring monthly reward for Celestial and above.', frequency: WealthRewardFrequency.MONTHLY }],
};

async function main(): Promise<void> {
  let benefitsCreated = 0;
  let benefitsSkipped = 0;
  for (const [levelStr, benefits] of Object.entries(BENEFITS)) {
    const level = Number(levelStr);
    const existing = await prisma.wealthLevelBenefit.count({ where: { level } });
    if (existing > 0) {
      benefitsSkipped += benefits.length;
      continue;
    }
    const data = await Promise.all(
      benefits.map(async (b) => {
        const cosmeticType = EQUIP_TYPE_MAP[b.type];
        const cosmeticId = cosmeticType ? await ensureCosmetic(cosmeticType, b.name) : undefined;
        return {
          level,
          benefitType: b.type,
          config: {
            name: b.name,
            ...(cosmeticId ? { cosmeticId } : {}),
            ...(b.config ?? {}),
          },
          isActive: true,
        };
      }),
    );
    await prisma.wealthLevelBenefit.createMany({ data });
    benefitsCreated += benefits.length;
  }

  let rewardsCreated = 0;
  let rewardsSkipped = 0;
  for (const [levelStr, rewards] of Object.entries(REWARDS)) {
    const level = Number(levelStr);
    const existing = await prisma.wealthLevelReward.count({ where: { level } });
    if (existing > 0) {
      rewardsSkipped += rewards.length;
      continue;
    }
    await prisma.wealthLevelReward.createMany({
      data: rewards.map((r) => ({
        level,
        rewardType: WealthRewardType.OTHER,
        rewardValue: { name: r.name, description: r.description, pendingSuperAdminConfiguration: true },
        frequency: r.frequency,
        grantType: WealthRewardGrantType.AUTOMATIC,
        // Inactive: no amount/value specified in the V1 document. Super Admin
        // must configure the real value and enable it before it goes live.
        isActive: false,
      })),
    });
    rewardsCreated += rewards.length;
  }

  console.log(`Wealth benefits: ${benefitsCreated} created, ${benefitsSkipped} skipped (level already seeded).`);
  console.log(`Wealth rewards: ${rewardsCreated} created (inactive, pending Super Admin configuration), ${rewardsSkipped} skipped.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
