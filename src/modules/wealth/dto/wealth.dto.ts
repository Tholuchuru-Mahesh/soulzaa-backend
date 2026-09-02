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
  IsUUID,
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
  'GOLD_COINS',
] as const;

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
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  iconUrl?: string | null;

  @IsOptional()
  @IsString()
  backgroundUrl?: string | null;
}

export class CreateWealthBenefitCategoryDto {
  @IsInt()
  @Min(0)
  level!: number;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  iconUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateWealthBenefitCategoryDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  iconUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateWealthBenefitDto {
  @IsInt()
  @Min(0)
  level!: number;

  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @IsIn(BENEFIT_TYPES)
  benefitType!: (typeof BENEFIT_TYPES)[number];

  @IsObject()
  config!: Record<string, unknown>;

  /** Grantable cosmetic-backed types only (PROFILE_FRAME/THEME/PROFILE_THEME/ENTRANCE_ANIMATION/BADGE). */
  @IsOptional()
  @IsUUID()
  cosmeticId?: string | null;

  /** GOLD_COINS type only. */
  @IsOptional()
  @IsInt()
  @Min(1)
  coinAmount?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  durationDays?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  iconUrl?: string | null;
}

export class UpdateWealthBenefitDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @IsOptional()
  @IsIn(BENEFIT_TYPES)
  benefitType?: (typeof BENEFIT_TYPES)[number];

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsUUID()
  cosmeticId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  coinAmount?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  durationDays?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  iconUrl?: string | null;
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
