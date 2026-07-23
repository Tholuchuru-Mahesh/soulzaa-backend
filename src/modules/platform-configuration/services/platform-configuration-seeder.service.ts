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
