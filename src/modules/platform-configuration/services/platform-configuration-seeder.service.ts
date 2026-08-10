import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SettingValueType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface DefaultSettingSeed {
  key: string;
  category: string;
  value: string;
  valueType: SettingValueType;
  defaultValue: string;
  description: string;
  isFeatureFlag?: boolean;
  isSecret?: boolean;
}

export const DEFAULT_PLATFORM_SETTINGS: DefaultSettingSeed[] = [
  {
    key: 'maintenance_mode',
    category: 'MAINTENANCE',
    value: 'false',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'false',
    description: 'Puts the entire platform in maintenance mode when set to true',
    isFeatureFlag: true,
  },
  {
    key: 'feature.audio_rooms.enabled',
    category: 'FEATURE_FLAGS',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'true',
    description: 'Enables or disables Audio Rooms feature platform-wide',
    isFeatureFlag: true,
  },
  {
    key: 'feature.video_rooms.enabled',
    category: 'FEATURE_FLAGS',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'true',
    description: 'Enables or disables Video Rooms feature platform-wide',
    isFeatureFlag: true,
  },
  {
    key: 'feature.games.enabled',
    category: 'FEATURE_FLAGS',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'true',
    description: 'Enables or disables Games feature platform-wide',
    isFeatureFlag: true,
  },
  {
    key: 'feature.events.enabled',
    category: 'FEATURE_FLAGS',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'true',
    description: 'Enables or disables Platform Events feature',
    isFeatureFlag: true,
  },
  {
    key: 'feature.wallet.enabled',
    category: 'FEATURE_FLAGS',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'true',
    description: 'Enables or disables Wallet transactions platform-wide',
    isFeatureFlag: true,
  },
  {
    key: 'feature.vip.enabled',
    category: 'FEATURE_FLAGS',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'true',
    description: 'Enables or disables VIP Membership system',
    isFeatureFlag: true,
  },
  {
    key: 'feature.family.enabled',
    category: 'FEATURE_FLAGS',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'true',
    description: 'Enables or disables Family system',
    isFeatureFlag: true,
  },
  {
    key: 'feature.treasure_boxes.enabled',
    category: 'FEATURE_FLAGS',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'true',
    description: 'Enables or disables Treasure Boxes feature',
    isFeatureFlag: true,
  },
  {
    key: 'feature.gifts.enabled',
    category: 'FEATURE_FLAGS',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'true',
    description: 'Enables or disables Virtual Gift economy',
    isFeatureFlag: true,
  },
  {
    key: 'auth.max_login_attempts',
    category: 'SECURITY',
    value: '5',
    valueType: SettingValueType.NUMBER,
    defaultValue: '5',
    description: 'Maximum failed login attempts before account lockout',
  },
  {
    key: 'auth.lockout_duration_minutes',
    category: 'SECURITY',
    value: '15',
    valueType: SettingValueType.NUMBER,
    defaultValue: '15',
    description: 'Account lockout duration in minutes',
  },
  {
    key: 'rate_limiting.max_requests_per_minute',
    category: 'RATE_LIMITING',
    value: '100',
    valueType: SettingValueType.NUMBER,
    defaultValue: '100',
    description: 'Maximum API requests per minute per IP/User',
  },
  {
    key: 'agora.app_id',
    category: 'AGORA',
    value: 'demo_agora_app_id',
    valueType: SettingValueType.STRING,
    defaultValue: 'demo_agora_app_id',
    description: 'Agora App ID for real-time audio/video streaming',
  },

  // ---------------------------------------------------------------------
  // Economy. The PRD requires every economy value to be configurable rather
  // than hardcoded, so each key a module reads is seeded here with the value
  // that module previously fell back to. Seeding changes no behaviour — it
  // makes the value visible and editable instead of buried beside a `??`.
  // ---------------------------------------------------------------------

  // Gift settlement (Soulzaa rule: EARNINGS +100% always; GOLD cashback only
  // above the threshold).
  {
    key: 'gift.receiver_earnings_percentage',
    category: 'ECONOMY',
    value: '100',
    valueType: SettingValueType.NUMBER,
    defaultValue: '100',
    description: 'Percent of gift value credited to the receiver EARNINGS wallet',
  },
  {
    key: 'gift.receiver_cashback_percentage',
    category: 'ECONOMY',
    value: '10',
    valueType: SettingValueType.NUMBER,
    defaultValue: '10',
    description: 'Percent of gift value credited to the receiver GOLD wallet as cashback',
  },
  {
    key: 'gift.receiver_cashback_threshold',
    category: 'ECONOMY',
    value: '1000',
    valueType: SettingValueType.NUMBER,
    defaultValue: '1000',
    description: 'Gift value must exceed this many coins before cashback is credited',
  },

  // Storefront tax. Resolved per country first, then this platform-wide
  // fallback, then none — see CoinPackageService.resolveTaxRatePercent. Lives
  // here rather than in the app because a rate baked into a shipped binary
  // cannot be corrected without a release.
  {
    key: 'payments.tax_rate_percent.IN',
    category: 'ECONOMY',
    value: '18',
    valueType: SettingValueType.NUMBER,
    defaultValue: '18',
    description: 'GST percent applied to Indian coin package prices (18% on digital services)',
  },
  {
    key: 'payments.tax_rate_percent',
    category: 'ECONOMY',
    value: '0',
    valueType: SettingValueType.NUMBER,
    defaultValue: '0',
    description:
      'Fallback tax percent for storefronts with no country-specific rate. Zero means no tax line is shown at all.',
  },

  // Host revenue distribution
  {
    key: 'host.revenue_percentage',
    category: 'ECONOMY',
    value: '100',
    valueType: SettingValueType.NUMBER,
    defaultValue: '100',
    description: 'Percent of gift value recorded as host earnings',
  },
  {
    key: 'platform.revenue_percentage',
    category: 'ECONOMY',
    value: '0',
    valueType: SettingValueType.NUMBER,
    defaultValue: '0',
    description: 'Percent of gift value recorded as platform revenue',
  },
  {
    key: 'minimum_payout',
    category: 'ECONOMY',
    value: '1',
    valueType: SettingValueType.NUMBER,
    defaultValue: '1',
    description: 'Smallest amount that may be recorded as a payout',
  },

  // Agency settlement
  {
    key: 'agency.commission_percentage',
    category: 'ECONOMY',
    value: '10',
    valueType: SettingValueType.NUMBER,
    defaultValue: '10',
    description: 'Percent of host revenue paid to the managing agency',
  },
  {
    key: 'agency.minimum_commission',
    category: 'ECONOMY',
    value: '1',
    valueType: SettingValueType.NUMBER,
    defaultValue: '1',
    description: 'Smallest agency commission that will be settled',
  },

  // Coin seller settlement
  {
    key: 'seller.commission_percentage',
    category: 'ECONOMY',
    value: '5',
    valueType: SettingValueType.NUMBER,
    defaultValue: '5',
    description: 'Percent commission paid to a coin seller',
  },
  {
    key: 'seller.minimum_commission',
    category: 'ECONOMY',
    value: '1',
    valueType: SettingValueType.NUMBER,
    defaultValue: '1',
    description: 'Smallest coin seller commission that will be settled',
  },

  // Reserved splits — defined so they are visible and configurable ahead of the
  // modules that will consume them. Zero means "not distributed yet".
  {
    key: 'future.agency_percentage',
    category: 'ECONOMY',
    value: '0',
    valueType: SettingValueType.NUMBER,
    defaultValue: '0',
    description: 'Reserved: agency share of gift revenue',
  },
  {
    key: 'future.referral_percentage',
    category: 'ECONOMY',
    value: '0',
    valueType: SettingValueType.NUMBER,
    defaultValue: '0',
    description: 'Reserved: referrer share of gift revenue',
  },
  {
    key: 'future.coin_seller_percentage',
    category: 'ECONOMY',
    value: '0',
    valueType: SettingValueType.NUMBER,
    defaultValue: '0',
    description: 'Reserved: coin seller share of gift revenue',
  },
  {
    key: 'future.subagency_percentage',
    category: 'ECONOMY',
    value: '0',
    valueType: SettingValueType.NUMBER,
    defaultValue: '0',
    description: 'Reserved: sub-agency share of agency commission',
  },
  {
    key: 'future.business_development_percentage',
    category: 'ECONOMY',
    value: '0',
    valueType: SettingValueType.NUMBER,
    defaultValue: '0',
    description: 'Reserved: business development share of agency commission',
  },
  {
    key: 'future.master_seller_percentage',
    category: 'ECONOMY',
    value: '0',
    valueType: SettingValueType.NUMBER,
    defaultValue: '0',
    description: 'Reserved: master seller share of seller commission',
  },
  {
    key: 'future.regional_seller_percentage',
    category: 'ECONOMY',
    value: '0',
    valueType: SettingValueType.NUMBER,
    defaultValue: '0',
    description: 'Reserved: regional seller share of seller commission',
  },

  // Withdrawals
  {
    key: 'withdrawal.minimum',
    category: 'ECONOMY',
    value: '1000',
    valueType: SettingValueType.NUMBER,
    defaultValue: '1000',
    description: 'Minimum withdrawal amount',
  },
  {
    key: 'withdrawal.maximum',
    category: 'ECONOMY',
    value: '100000',
    valueType: SettingValueType.NUMBER,
    defaultValue: '100000',
    description: 'Maximum amount for a single withdrawal',
  },
  {
    key: 'withdrawal.daily_limit',
    category: 'ECONOMY',
    value: '200000',
    valueType: SettingValueType.NUMBER,
    defaultValue: '200000',
    description: 'Maximum total withdrawal per user per day',
  },
  {
    key: 'withdrawal.monthly_limit',
    category: 'ECONOMY',
    value: '1000000',
    valueType: SettingValueType.NUMBER,
    defaultValue: '1000000',
    description: 'Maximum total withdrawal per user per month',
  },
  {
    key: 'withdrawal.processing_fee',
    category: 'ECONOMY',
    value: '0',
    valueType: SettingValueType.NUMBER,
    defaultValue: '0',
    description: 'Flat fee deducted from a withdrawal',
  },
  {
    key: 'withdrawal.tax_percentage',
    category: 'ECONOMY',
    value: '0',
    valueType: SettingValueType.NUMBER,
    defaultValue: '0',
    description: 'Percent tax withheld from a withdrawal',
  },

  // Treasure boxes
  {
    key: 'treasure.reward_pool_percentage',
    category: 'TREASURE_BOX',
    value: '50',
    valueType: SettingValueType.NUMBER,
    defaultValue: '50',
    description: 'Percent of a completed box that forms the reward pool',
  },
  {
    key: 'treasure.min_winners',
    category: 'TREASURE_BOX',
    value: '5',
    valueType: SettingValueType.NUMBER,
    defaultValue: '5',
    description: 'Minimum participants rewarded when a box completes',
  },
  {
    key: 'treasure.max_winners',
    category: 'TREASURE_BOX',
    value: '7',
    valueType: SettingValueType.NUMBER,
    defaultValue: '7',
    description: 'Maximum participants rewarded when a box completes',
  },

  // VIP
  {
    key: 'vip.max_level',
    category: 'VIP',
    value: '10',
    valueType: SettingValueType.NUMBER,
    defaultValue: '10',
    description: 'Highest VIP tier available',
  },
  {
    key: 'vip.default_duration',
    category: 'VIP',
    value: '30',
    valueType: SettingValueType.NUMBER,
    defaultValue: '30',
    description: 'Default VIP membership duration in days',
  },
  {
    key: 'vip.auto_renew',
    category: 'VIP',
    value: 'false',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'false',
    description: 'Whether VIP memberships renew automatically',
  },
  {
    key: 'vip.reward_reset',
    category: 'VIP',
    value: '00:00:00',
    valueType: SettingValueType.STRING,
    defaultValue: '00:00:00',
    description: 'Daily time at which VIP rewards reset',
  },
  {
    key: 'vip.discount_limits',
    category: 'VIP',
    value: '20',
    valueType: SettingValueType.NUMBER,
    defaultValue: '20',
    description: 'Maximum percent discount a VIP tier may grant',
  },

  // Family
  {
    key: 'family.max_members',
    category: 'FAMILY',
    value: '100',
    valueType: SettingValueType.NUMBER,
    defaultValue: '100',
    description: 'Maximum members in a family',
  },
  {
    key: 'family.creation_cost',
    category: 'FAMILY',
    value: '1000',
    valueType: SettingValueType.NUMBER,
    defaultValue: '1000',
    description: 'Gold coins charged to create a family',
  },
  {
    key: 'family.rename_cost',
    category: 'FAMILY',
    value: '500',
    valueType: SettingValueType.NUMBER,
    defaultValue: '500',
    description: 'Gold coins charged to rename a family',
  },
  {
    key: 'family.default_role',
    category: 'FAMILY',
    value: 'MEMBER',
    valueType: SettingValueType.STRING,
    defaultValue: 'MEMBER',
    description: 'Role granted to a newly joined family member',
  },
  {
    key: 'family.auto_approve',
    category: 'FAMILY',
    value: 'false',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'false',
    description: 'Whether family join requests are approved automatically',
  },
  {
    key: 'family.join_cooldown',
    category: 'FAMILY',
    value: '86400',
    valueType: SettingValueType.NUMBER,
    defaultValue: '86400',
    description: 'Seconds a user must wait before joining another family',
  },
  {
    key: 'feature.attendance.enabled',
    category: 'FEATURE_FLAGS',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'true',
    description: 'Enables or disables daily attendance rewards platform-wide',
    isFeatureFlag: true,
  },
  {
    key: 'attendance.min_hours_between_claims',
    category: 'ECONOMY',
    value: '20',
    valueType: SettingValueType.NUMBER,
    defaultValue: '20',
    description:
      'Minimum hours between attendance claims, enforced only when the user country (and so timezone) changed',
  },

  // ---------------------------------------------------------------------
  // The settings below back-fill keys that modules already read through a
  // `?? <literal>` fallback (or an in-memory default parameter) but that were
  // never seeded. Each value is copied verbatim from that fallback so seeding
  // an environment does not change behaviour versus leaving it unseeded.
  // ---------------------------------------------------------------------

  // Achievements — src/modules/achievements/services/achievement-configuration.service.ts
  {
    key: 'achievement.max_progress',
    category: 'ACHIEVEMENT',
    value: '10000',
    valueType: SettingValueType.NUMBER,
    defaultValue: '10000',
    description: 'Highest progress value an achievement can track before it is considered complete',
  },
  {
    key: 'achievement.auto_claim',
    category: 'ACHIEVEMENT',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'true',
    description: 'Whether unlocked achievement rewards are claimed automatically',
  },
  {
    key: 'badge.default_visibility',
    category: 'ACHIEVEMENT',
    value: 'PUBLIC',
    valueType: SettingValueType.STRING,
    defaultValue: 'PUBLIC',
    description: 'Visibility assigned to a badge when none is explicitly set',
  },
  {
    key: 'reward.claim_window',
    category: 'ACHIEVEMENT',
    value: '30',
    valueType: SettingValueType.NUMBER,
    defaultValue: '30',
    description: 'Days an achievement reward remains claimable before it expires',
  },

  // Analytics — src/modules/analytics/services/analytics-configuration.service.ts
  {
    key: 'analytics.snapshot_interval',
    category: 'ANALYTICS',
    value: '60',
    valueType: SettingValueType.NUMBER,
    defaultValue: '60',
    description: 'Minutes between analytics snapshot rollups',
  },
  {
    key: 'analytics.retention_days',
    category: 'ANALYTICS',
    value: '90',
    valueType: SettingValueType.NUMBER,
    defaultValue: '90',
    description: 'Days raw analytics data is retained before it is purged',
  },
  {
    key: 'analytics.export_limit',
    category: 'ANALYTICS',
    value: '5000',
    valueType: SettingValueType.NUMBER,
    defaultValue: '5000',
    description: 'Maximum rows included in a single analytics export',
  },
  {
    key: 'analytics.default_timezone',
    category: 'ANALYTICS',
    value: 'UTC',
    valueType: SettingValueType.STRING,
    defaultValue: 'UTC',
    description: 'Timezone used to bucket analytics reports when none is requested',
  },
  {
    key: 'analytics.cache_ttl',
    category: 'ANALYTICS',
    value: '300',
    valueType: SettingValueType.NUMBER,
    defaultValue: '300',
    description: 'Seconds an analytics query result is cached before recomputation',
  },

  // Admin dashboard — src/modules/admin-dashboard/services/dashboard-configuration.service.ts
  {
    key: 'dashboard.refresh_interval',
    category: 'DASHBOARD',
    value: '30',
    valueType: SettingValueType.NUMBER,
    defaultValue: '30',
    description: 'Seconds between automatic dashboard data refreshes',
  },
  {
    key: 'dashboard.default_layout',
    category: 'DASHBOARD',
    value: 'GRID_3X3',
    valueType: SettingValueType.STRING,
    defaultValue: 'GRID_3X3',
    description: 'Widget layout applied to a dashboard that has not been customised',
  },
  {
    key: 'dashboard.widget_limit',
    category: 'DASHBOARD',
    value: '20',
    valueType: SettingValueType.NUMBER,
    defaultValue: '20',
    description: 'Maximum widgets a single dashboard may contain',
  },
  {
    key: 'dashboard.export_limit',
    category: 'DASHBOARD',
    value: '1000',
    valueType: SettingValueType.NUMBER,
    defaultValue: '1000',
    description: 'Maximum rows included in a single dashboard export',
  },
  {
    key: 'dashboard.cache_ttl',
    category: 'DASHBOARD',
    value: '60',
    valueType: SettingValueType.NUMBER,
    defaultValue: '60',
    description: 'Seconds a dashboard widget result is cached before recomputation',
  },

  // Enterprise events — src/modules/enterprise-events/services/event-configuration.service.ts
  {
    key: 'event.max_participants',
    category: 'EVENT',
    value: '1000',
    valueType: SettingValueType.NUMBER,
    defaultValue: '1000',
    description: 'Maximum participants an event may accept',
  },
  {
    key: 'event.registration_duration',
    category: 'EVENT',
    value: '24',
    valueType: SettingValueType.NUMBER,
    defaultValue: '24',
    description: 'Hours a newly created event stays open for registration',
  },
  {
    key: 'event.default_visibility',
    category: 'EVENT',
    value: 'PUBLIC',
    valueType: SettingValueType.STRING,
    defaultValue: 'PUBLIC',
    description: 'Visibility assigned to an event when none is explicitly set',
  },
  {
    key: 'event.reward_claim_window',
    category: 'EVENT',
    value: '30',
    valueType: SettingValueType.NUMBER,
    defaultValue: '30',
    description: 'Days an event reward remains claimable before it expires',
  },
  {
    key: 'event.auto_archive_days',
    category: 'EVENT',
    value: '90',
    valueType: SettingValueType.NUMBER,
    defaultValue: '90',
    description: 'Days after completion before an event is automatically archived',
  },

  // Notification centre — src/modules/notification/services/notification-configuration.service.ts
  {
    key: 'notification.retry_count',
    category: 'NOTIFICATION',
    value: '3',
    valueType: SettingValueType.NUMBER,
    defaultValue: '3',
    description: 'Times a failed notification dispatch is retried',
  },
  {
    key: 'notification.default_channel',
    category: 'NOTIFICATION',
    value: 'IN_APP',
    valueType: SettingValueType.STRING,
    defaultValue: 'IN_APP',
    description: 'Delivery channel used when a notification does not specify one',
  },
  {
    key: 'notification.retention_days',
    category: 'NOTIFICATION',
    value: '30',
    valueType: SettingValueType.NUMBER,
    defaultValue: '30',
    description: 'Days a delivered notification is kept before it is purged',
  },
  {
    key: 'notification.batch_size',
    category: 'NOTIFICATION',
    value: '100',
    valueType: SettingValueType.NUMBER,
    defaultValue: '100',
    description: 'Notifications dispatched per batch when sending in bulk',
  },
  {
    key: 'notification.broadcast_limit',
    category: 'NOTIFICATION',
    value: '5',
    valueType: SettingValueType.NUMBER,
    defaultValue: '5',
    description: 'Maximum broadcast announcements a sender may issue at once',
  },

  // Enterprise rankings — src/modules/enterprise-rankings/services/ranking-configuration.service.ts
  {
    key: 'ranking.refresh_interval',
    category: 'RANKING',
    value: '300',
    valueType: SettingValueType.NUMBER,
    defaultValue: '300',
    description: 'Seconds between leaderboard refresh cycles',
  },
  {
    key: 'ranking.snapshot_interval',
    category: 'RANKING',
    value: '86400',
    valueType: SettingValueType.NUMBER,
    defaultValue: '86400',
    description: 'Seconds between ranking snapshot captures',
  },
  {
    key: 'ranking.max_entries',
    category: 'RANKING',
    value: '1000',
    valueType: SettingValueType.NUMBER,
    defaultValue: '1000',
    description: 'Maximum entries retained on a single leaderboard',
  },
  {
    key: 'ranking.score_decay',
    category: 'RANKING',
    value: 'false',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'false',
    description: 'Whether ranking scores decay over time instead of staying fixed',
  },
  {
    key: 'ranking.default_visibility',
    category: 'RANKING',
    value: 'PUBLIC',
    valueType: SettingValueType.STRING,
    defaultValue: 'PUBLIC',
    description: 'Visibility assigned to a ranking board when none is explicitly set',
  },

  // Referrals — src/modules/referrals/services/referral-configuration.service.ts
  {
    // Declared in REFERRAL_CONFIG_KEYS but not yet read by any code, so there is
    // no inline fallback to copy. Seeded to match its siblings
    // `event.reward_claim_window` and `task.reward_claim_window`, which the
    // referral engine will want to agree with when it starts dispatching rewards.
    key: 'referral.reward_claim_window',
    category: 'REFERRAL',
    value: '30',
    valueType: SettingValueType.NUMBER,
    defaultValue: '30',
    description: 'Days a referral reward remains claimable before it expires',
  },
  {
    key: 'referral.default_expiry_days',
    category: 'REFERRAL',
    value: '30',
    valueType: SettingValueType.NUMBER,
    defaultValue: '30',
    description: 'Days an unused referral code remains valid',
  },
  {
    key: 'referral.max_uses',
    category: 'REFERRAL',
    value: '100',
    valueType: SettingValueType.NUMBER,
    defaultValue: '100',
    description: 'Maximum times a single referral code may be redeemed',
  },
  {
    key: 'referral.self_referral_allowed',
    category: 'REFERRAL',
    value: 'false',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'false',
    description: 'Whether a user is allowed to redeem their own referral code',
  },
  {
    key: 'referral.qualification_timeout',
    category: 'REFERRAL',
    value: '7',
    valueType: SettingValueType.NUMBER,
    defaultValue: '7',
    description: 'Days a referred user has to qualify before the referral expires',
  },

  // Tasks & missions — src/modules/tasks/services/task-configuration.service.ts
  {
    key: 'task.daily_reset',
    category: 'TASK',
    value: '00:00',
    valueType: SettingValueType.STRING,
    defaultValue: '00:00',
    description: 'Clock time at which daily tasks reset',
  },
  {
    key: 'task.weekly_reset',
    category: 'TASK',
    value: 'MON',
    valueType: SettingValueType.STRING,
    defaultValue: 'MON',
    description: 'Day of week on which weekly missions reset',
  },
  {
    key: 'task.max_progress',
    category: 'TASK',
    value: '1000000',
    valueType: SettingValueType.NUMBER,
    defaultValue: '1000000',
    description: 'Highest progress value a task can track before it is considered complete',
  },
  {
    key: 'task.reward_claim_window',
    category: 'TASK',
    value: '30',
    valueType: SettingValueType.NUMBER,
    defaultValue: '30',
    description: 'Days a task reward remains claimable before it expires',
  },
  {
    key: 'task.auto_claim',
    category: 'TASK',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    defaultValue: 'true',
    description: 'Whether completed task rewards are claimed automatically',
  },
];

@Injectable()
export class PlatformConfigurationSeederService implements OnModuleInit {
  private readonly logger = new Logger(PlatformConfigurationSeederService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedDefaults();
  }

  async seedDefaults() {
    for (const seed of DEFAULT_PLATFORM_SETTINGS) {
      await this.prisma.platformSetting.upsert({
        where: { key: seed.key },
        update: {},
        create: {
          key: seed.key,
          category: seed.category,
          value: seed.value,
          valueType: seed.valueType,
          defaultValue: seed.defaultValue,
          description: seed.description,
          isFeatureFlag: seed.isFeatureFlag ?? false,
          isSecret: seed.isSecret ?? false,
        },
      });
    }
  }
}
