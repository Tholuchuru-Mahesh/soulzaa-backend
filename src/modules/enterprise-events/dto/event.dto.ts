import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { EVENT_CATEGORIES, EVENT_STATUSES, EVENT_VISIBILITIES } from '../constants/event.constants';

// ─── Event Definition DTOs ────────────────────────────────────────────

export class CreateEventDto {
  @ApiProperty({ description: 'Unique code for the event', example: 'SUMMER_FESTIVAL_2025' })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiProperty({ description: 'Display name', example: 'Summer Festival Tournament' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ description: 'Event description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: EVENT_CATEGORIES, description: 'Event category' })
  @IsEnum(EVENT_CATEGORIES)
  category!: string;

  @ApiPropertyOptional({ description: 'Banner image URL' })
  @IsOptional()
  @IsString()
  banner?: string;

  @ApiPropertyOptional({ description: 'Thumbnail URL' })
  @IsOptional()
  @IsString()
  thumbnail?: string;

  @ApiProperty({ description: 'Event start time (ISO 8601)' })
  @IsDateString()
  startTime!: string;

  @ApiProperty({ description: 'Event end time (ISO 8601)' })
  @IsDateString()
  endTime!: string;

  @ApiPropertyOptional({ description: 'Registration start time (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  regStartTime?: string;

  @ApiPropertyOptional({ description: 'Registration end time (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  regEndTime?: string;

  @ApiPropertyOptional({
    description: 'Participation rules JSON',
    example: { winCondition: 'TOP_GIFTER' },
  })
  @IsOptional()
  @IsObject()
  participationRules?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Eligibility rules JSON',
    example: { minLevel: 5, minVipLevel: 1 },
  })
  @IsOptional()
  @IsObject()
  eligibilityRules?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Reward definition JSON',
    example: { type: 'EXP', amount: 1000 },
  })
  @IsOptional()
  @IsObject()
  rewardDefinition?: Record<string, any>;

  @ApiPropertyOptional({ default: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxParticipants?: number;

  @ApiPropertyOptional({ enum: EVENT_VISIBILITIES, default: 'PUBLIC' })
  @IsOptional()
  @IsEnum(EVENT_VISIBILITIES)
  visibility?: string;

  @ApiPropertyOptional({ example: 'US' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ example: 'NA' })
  @IsOptional()
  @IsString()
  region?: string;

  @ApiPropertyOptional({ example: 'Summer2025' })
  @IsOptional()
  @IsString()
  season?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  priority?: number;

  @ApiPropertyOptional({ enum: EVENT_STATUSES, default: 'SCHEDULED' })
  @IsOptional()
  @IsEnum(EVENT_STATUSES)
  status?: string;

  @ApiPropertyOptional({
    description: 'Event task definitions with rewards and conditions',
    type: 'array',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EventTaskDefinitionDto)
  tasks?: EventTaskDefinitionDto[];
}

export class EventTaskDefinitionDto {
  @ApiPropertyOptional({ description: 'Unique code for the task (auto-generated if omitted)' })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiProperty({ description: 'Task name/title', example: 'Join Live Stream' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ description: 'Task description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ description: 'Task objective/trigger code', example: 'STREAM_WATCH' })
  @IsString()
  @IsNotEmpty()
  objective!: string;

  @ApiPropertyOptional({ description: 'Required progress count to complete task', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  requiredProgress?: number;

  @ApiPropertyOptional({ description: 'Difficulty level', default: 'EASY' })
  @IsOptional()
  @IsString()
  difficulty?: string;

  @ApiPropertyOptional({ description: 'Task priority', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  priority?: number;

  @ApiPropertyOptional({
    description: 'Reward definition (e.g. coins, diamonds, exp, badge)',
    example: { coins: 100, exp: 50 },
  })
  @IsOptional()
  @IsObject()
  rewardDefinition?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Progress rules JSON' })
  @IsOptional()
  @IsObject()
  progressRules?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Completion rules JSON' })
  @IsOptional()
  @IsObject()
  completionRules?: Record<string, any>;
}

export class UpdateEventDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: EVENT_CATEGORIES })
  @IsOptional()
  @IsEnum(EVENT_CATEGORIES)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  banner?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  thumbnail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  regStartTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  regEndTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  participationRules?: Record<string, any>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  eligibilityRules?: Record<string, any>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  rewardDefinition?: Record<string, any>;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxParticipants?: number;

  @ApiPropertyOptional({ enum: EVENT_VISIBILITIES })
  @IsOptional()
  @IsEnum(EVENT_VISIBILITIES)
  visibility?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  region?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  season?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  priority?: number;

  @ApiPropertyOptional({
    description: 'Event task definitions with rewards and conditions',
    type: 'array',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EventTaskDefinitionDto)
  tasks?: EventTaskDefinitionDto[];
}

export class UpdateEventStatusDto {
  @ApiProperty({ enum: EVENT_STATUSES })
  @IsEnum(EVENT_STATUSES)
  status!: string;
}

// ─── Registration & Participation DTOs ────────────────────────────────

export class RegisterEventDto {
  @ApiProperty({ description: 'User ID registering for the event' })
  @IsUUID()
  userId!: string;
}

export class UpdateParticipantScoreDto {
  @ApiProperty({ description: 'User ID' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ description: 'Score delta to add', example: 100 })
  @Type(() => Number)
  @IsInt()
  scoreDelta!: number;
}

export class DisqualifyParticipantDto {
  @ApiProperty({ description: 'User ID' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ description: 'Disqualification reason', example: 'Violation of rules' })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

export class DispatchRewardDto {
  @ApiProperty({ description: 'User ID' })
  @IsUUID()
  userId!: string;

  @ApiPropertyOptional({ description: 'Optional custom reward override' })
  @IsOptional()
  @IsObject()
  customReward?: Record<string, any>;
}

// ─── Configuration DTO ──────────────────────────────────────────────────

export class UpdateEventConfigurationDto {
  @ApiProperty({ description: 'Configuration key', example: 'event.max_participants' })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiProperty({ description: 'Configuration value' })
  value!: any;
}
