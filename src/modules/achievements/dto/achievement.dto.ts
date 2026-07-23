import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import {
  ACHIEVEMENT_CATEGORIES,
  ACHIEVEMENT_STATUS,
  ACHIEVEMENT_VISIBILITY,
  BADGE_RARITIES,
  BADGE_TIERS,
  BADGE_TYPES,
} from '../constants/achievement.constants';

// ─── Achievement Definition DTOs ────────────────────────────────────────────

export class CreateAchievementDto {
  @ApiProperty({ description: 'Unique code for the achievement', example: 'GIFT_MASTER_100' })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiProperty({ description: 'Display name', example: 'Gift Master' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ description: 'Description shown to the user' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: ACHIEVEMENT_CATEGORIES, description: 'Achievement category' })
  @IsEnum(ACHIEVEMENT_CATEGORIES)
  category!: string;

  @ApiPropertyOptional({ description: 'Badge code to award on unlock' })
  @IsOptional()
  @IsString()
  badgeCode?: string;

  @ApiPropertyOptional({ description: 'Icon asset URL' })
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiPropertyOptional({ description: 'Display order', example: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  displayOrder?: number;

  @ApiPropertyOptional({ enum: ACHIEVEMENT_VISIBILITY, default: 'PUBLIC' })
  @IsOptional()
  @IsEnum(ACHIEVEMENT_VISIBILITY)
  visibility?: string;

  @ApiProperty({ description: 'How many units of progress needed to unlock', example: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  requiredProgress!: number;

  @ApiPropertyOptional({
    description: 'JSON rule evaluated by the evaluation engine',
    example: { eventCodes: ['GIFT_SENT'], operator: 'ANY' },
  })
  @IsOptional()
  @IsObject()
  unlockRule?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'JSON reward definition (dispatched via event)',
    example: { type: 'EXP', amount: 500 },
  })
  @IsOptional()
  @IsObject()
  rewardDefinition?: Record<string, any>;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  repeatable?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  hidden?: boolean;

  @ApiPropertyOptional({ description: 'Optional expiry date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class UpdateAchievementStatusDto {
  @ApiProperty({ enum: ACHIEVEMENT_STATUS })
  @IsEnum(ACHIEVEMENT_STATUS)
  status!: string;
}

// ─── Badge Definition DTOs ──────────────────────────────────────────────────

export class CreateBadgeDto {
  @ApiProperty({ description: 'Unique badge code', example: 'GIFT_MASTER_GOLD' })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiProperty({ description: 'Display name', example: 'Gift Master (Gold)' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: BADGE_TIERS, default: 'BRONZE' })
  @IsOptional()
  @IsEnum(BADGE_TIERS)
  tier?: string;

  @ApiPropertyOptional({ enum: BADGE_TYPES, default: 'STANDARD' })
  @IsOptional()
  @IsEnum(BADGE_TYPES)
  badgeType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  iconUrl?: string;

  @ApiPropertyOptional({ description: 'Animation asset URL for animated badges' })
  @IsOptional()
  @IsString()
  animationUrl?: string;

  @ApiPropertyOptional({ enum: BADGE_RARITIES, default: 'COMMON' })
  @IsOptional()
  @IsEnum(BADGE_RARITIES)
  rarity?: string;

  @ApiPropertyOptional({ description: 'Season name for seasonal badges', example: 'Summer2025' })
  @IsOptional()
  @IsString()
  season?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class EquipBadgeDto {
  @ApiProperty({ description: 'Badge code to equip', example: 'GIFT_MASTER_GOLD' })
  @IsString()
  @IsNotEmpty()
  badgeCode!: string;
}

export class AdminGrantBadgeDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  badgeCode!: string;
}

export class ManualGrantAchievementDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;

  @ApiProperty()
  @IsUUID()
  achievementId!: string;
}

// ─── Evaluation DTOs ────────────────────────────────────────────────────────

export class EvaluateEventDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;

  @ApiProperty({ description: 'Domain event code', example: 'GIFT_SENT' })
  @IsString()
  @IsNotEmpty()
  eventCode!: string;

  @ApiPropertyOptional({
    description: 'Event metadata for rule evaluation',
    example: { amount: 50 },
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

// ─── Configuration DTOs ─────────────────────────────────────────────────────

export class UpdateAchievementConfigurationDto {
  @ApiProperty({ description: 'Configuration key', example: 'achievement.auto_claim' })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiProperty({ description: 'Configuration value' })
  value!: any;
}

// ─── Reward Claim DTO ───────────────────────────────────────────────────────

export class ClaimRewardDto {
  @ApiProperty({ description: 'Achievement ID to claim reward for' })
  @IsUUID()
  achievementId!: string;
}
