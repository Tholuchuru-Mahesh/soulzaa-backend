import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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
  RANKING_CATEGORIES,
  RANKING_ENTITY_TYPES,
  RANKING_STATUSES,
  RANKING_TIME_WINDOWS,
  RANKING_VISIBILITIES,
} from '../constants/ranking.constants';

// ─── Ranking Definition DTOs ────────────────────────────────────────────

export class CreateRankingDefinitionDto {
  @ApiProperty({
    description: 'Unique code for the ranking definition',
    example: 'DAILY_GIFTERS_GLOBAL',
  })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiProperty({ description: 'Display name', example: 'Daily Top Gifters' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ description: 'Description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: RANKING_CATEGORIES, description: 'Ranking category' })
  @IsEnum(RANKING_CATEGORIES)
  category!: string;

  @ApiPropertyOptional({ description: 'Subcategory' })
  @IsOptional()
  @IsString()
  subcategory?: string;

  @ApiPropertyOptional({ enum: RANKING_ENTITY_TYPES, default: 'USER' })
  @IsOptional()
  @IsEnum(RANKING_ENTITY_TYPES)
  entityType?: string;

  @ApiPropertyOptional({ enum: RANKING_TIME_WINDOWS, default: 'DAILY' })
  @IsOptional()
  @IsEnum(RANKING_TIME_WINDOWS)
  timeWindow?: string;

  @ApiPropertyOptional({
    description: 'JSON score formula rule',
    example: { eventCodes: ['GIFT_SENT'], multiplier: 1.0 },
  })
  @IsOptional()
  @IsObject()
  scoreFormula?: Record<string, any>;

  @ApiPropertyOptional({ enum: RANKING_VISIBILITIES, default: 'PUBLIC' })
  @IsOptional()
  @IsEnum(RANKING_VISIBILITIES)
  visibility?: string;

  @ApiPropertyOptional({ default: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxEntries?: number;

  @ApiPropertyOptional({ example: 'US' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ example: 'NA' })
  @IsOptional()
  @IsString()
  region?: string;

  @ApiPropertyOptional({ example: 'Season1' })
  @IsOptional()
  @IsString()
  season?: string;
}

export class UpdateRankingStatusDto {
  @ApiProperty({ enum: RANKING_STATUSES })
  @IsEnum(RANKING_STATUSES)
  status!: string;
}

// ─── Score Application / Manual Adjustment DTOs ────────────────────────

export class ManualScoreAdjustmentDto {
  @ApiProperty({ description: 'Ranking Definition ID' })
  @IsUUID()
  rankingId!: string;

  @ApiProperty({ description: 'Target entity ID' })
  @IsUUID()
  entityId!: string;

  @ApiProperty({ enum: RANKING_ENTITY_TYPES, default: 'USER' })
  @IsEnum(RANKING_ENTITY_TYPES)
  entityType!: string;

  @ApiProperty({ description: 'New absolute score value', example: 5000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  newScore!: number;

  @ApiProperty({ description: 'Reason for adjustment', example: 'System correction' })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

export class AggregateScoreEventDto {
  @ApiProperty({ description: 'Target entity ID' })
  @IsUUID()
  entityId!: string;

  @ApiProperty({ enum: RANKING_ENTITY_TYPES, default: 'USER' })
  @IsEnum(RANKING_ENTITY_TYPES)
  entityType!: string;

  @ApiProperty({ description: 'Event source code', example: 'GIFT_SENT' })
  @IsString()
  @IsNotEmpty()
  eventCode!: string;

  @ApiProperty({ description: 'Raw score value to add', example: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  rawScore!: number;

  @ApiPropertyOptional({ description: 'Optional metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

// ─── Snapshot Trigger DTO ───────────────────────────────────────────────

export class TriggerSnapshotDto {
  @ApiProperty({ description: 'Ranking Definition ID' })
  @IsUUID()
  rankingId!: string;

  @ApiProperty({ description: 'Period', example: 'DAILY' })
  @IsString()
  @IsNotEmpty()
  period!: string;

  @ApiProperty({ description: 'Date key', example: '20260723' })
  @IsString()
  @IsNotEmpty()
  dateKey!: string;
}

// ─── Configuration DTO ──────────────────────────────────────────────────

export class UpdateRankingConfigurationDto {
  @ApiProperty({ description: 'Configuration key', example: 'ranking.max_entries' })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiProperty({ description: 'Configuration value' })
  value!: any;
}
