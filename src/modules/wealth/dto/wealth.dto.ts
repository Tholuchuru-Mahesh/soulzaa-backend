import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

const BENEFIT_TYPES = [
  'BADGE',
  'PROFILE_FRAME',
  'AVATAR_EFFECT',
  'AVATAR_RING',
  'CHAT_BUBBLE',
  'CHAT_EFFECT',
  'CHAT_HIGHLIGHT',
  'ROOM_EFFECT',
  'GIFT_EFFECT',
  'THEME',
  'PROFILE_THEME',
  'ANIMATION',
  'ENTRANCE_ANIMATION',
  'PROFILE_STYLE',
  'THEME_SLOTS',
  'CUSTOM_GIFT_CREATOR',
  'VISITOR_HISTORY',
  'STICKER_PACK',
  'ANONYMOUS_ENTRY',
  'ANONYMOUS_GIFT',
  'MIC_PRIORITY',
  'VOICE_EFFECT',
  'SUPPORT_PRIORITY',
  'PROFILE_SHOWCASE',
  'EVENT_ACCESS',
  'VIP_HALL',
  'RELATIONSHIP_MANAGER',
  'FEATURE_ACCESS',
  'RECOGNITION',
  'OTHER',
] as const;

const REWARD_TYPES = ['GOLD_COINS', 'COSMETIC', 'BADGE', 'PROFILE_FRAME', 'OTHER'] as const;
const REWARD_FREQUENCIES = ['ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY'] as const;
const REWARD_GRANT_TYPES = ['AUTOMATIC', 'CLAIMABLE'] as const;

export class UpsertWealthLevelDto {
  @IsInt()
  @Min(0)
  level!: number;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsInt()
  @Min(0)
  expThreshold!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  iconUrl?: string | null;
}

export class CreateWealthBenefitDto {
  @IsInt()
  @Min(0)
  level!: number;

  @IsIn(BENEFIT_TYPES)
  benefitType!: (typeof BENEFIT_TYPES)[number];

  @IsObject()
  config!: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  iconUrl?: string | null;
}

export class UpdateWealthBenefitDto {
  @IsOptional()
  @IsIn(BENEFIT_TYPES)
  benefitType?: (typeof BENEFIT_TYPES)[number];

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  iconUrl?: string | null;
}

export class CreateWealthRewardDto {
  @IsInt()
  @Min(0)
  level!: number;

  @IsIn(REWARD_TYPES)
  rewardType!: (typeof REWARD_TYPES)[number];

  @IsObject()
  rewardValue!: Record<string, unknown>;

  @IsIn(REWARD_FREQUENCIES)
  frequency!: (typeof REWARD_FREQUENCIES)[number];

  @IsIn(REWARD_GRANT_TYPES)
  grantType!: (typeof REWARD_GRANT_TYPES)[number];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsISO8601()
  startAt?: string;

  @IsOptional()
  @IsISO8601()
  endAt?: string;
}

export class UpdateWealthRewardDto {
  @IsOptional()
  @IsIn(REWARD_TYPES)
  rewardType?: (typeof REWARD_TYPES)[number];

  @IsOptional()
  @IsObject()
  rewardValue?: Record<string, unknown>;

  @IsOptional()
  @IsIn(REWARD_FREQUENCIES)
  frequency?: (typeof REWARD_FREQUENCIES)[number];

  @IsOptional()
  @IsIn(REWARD_GRANT_TYPES)
  grantType?: (typeof REWARD_GRANT_TYPES)[number];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsISO8601()
  startAt?: string;

  @IsOptional()
  @IsISO8601()
  endAt?: string;
}

export class UpdateWealthDowngradeConfigDto {
  @IsBoolean()
  enabled!: boolean;

  @IsInt()
  @Min(0)
  maxDowngradeLevels!: number;

  @IsInt()
  @Min(0)
  minLevel!: number;

  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  @IsOptional()
  @IsISO8601()
  effectiveTo?: string;
}

export class UpdateWealthConfigurationDto {
  @IsString()
  @IsNotEmpty()
  key!: string;

  @IsNotEmpty()
  value!: unknown;
}

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
