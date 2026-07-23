import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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
  RESET_POLICIES,
  TASK_CATEGORIES,
  TASK_DIFFICULTIES,
  TASK_STATUSES,
  TASK_VISIBILITIES,
} from '../constants/task.constants';

// ─── Task Definition DTOs ─────────────────────────────────────────────

export class CreateTaskDto {
  @ApiProperty({ description: 'Unique code for the task', example: 'DAILY_GIFT_1' })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiPropertyOptional({ description: 'Parent Mission ID if grouped under a mission' })
  @IsOptional()
  @IsUUID()
  missionId?: string;

  @ApiProperty({ description: 'Display name', example: 'Send 1 Gift' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ description: 'Description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: TASK_CATEGORIES, description: 'Task category' })
  @IsEnum(TASK_CATEGORIES)
  category!: string;

  @ApiProperty({ description: 'Task objective summary', example: 'Send 1 gift in any room' })
  @IsString()
  @IsNotEmpty()
  objective!: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  requiredProgress?: number;

  @ApiPropertyOptional({
    description: 'JSON progress evaluation rule',
    example: { eventCodes: ['GIFT_SENT'], operator: 'ANY' },
  })
  @IsOptional()
  @IsObject()
  progressRules?: Record<string, any>;

  @ApiPropertyOptional({ description: 'JSON completion rules' })
  @IsOptional()
  @IsObject()
  completionRules?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Reward definition JSON',
    example: { type: 'EXP', amount: 100 },
  })
  @IsOptional()
  @IsObject()
  rewardDefinition?: Record<string, any>;

  @ApiPropertyOptional({ enum: TASK_VISIBILITIES, default: 'PUBLIC' })
  @IsOptional()
  @IsEnum(TASK_VISIBILITIES)
  visibility?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  priority?: number;

  @ApiPropertyOptional({ enum: TASK_DIFFICULTIES, default: 'EASY' })
  @IsOptional()
  @IsEnum(TASK_DIFFICULTIES)
  difficulty?: string;

  @ApiPropertyOptional({ description: 'Start time (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  startTime?: string;

  @ApiPropertyOptional({ description: 'End time (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  endTime?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  repeatable?: boolean;

  @ApiPropertyOptional({ enum: RESET_POLICIES, default: 'DAILY' })
  @IsOptional()
  @IsEnum(RESET_POLICIES)
  resetPolicy?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxCompletions?: number;
}

export class UpdateTaskStatusDto {
  @ApiProperty({ enum: TASK_STATUSES })
  @IsEnum(TASK_STATUSES)
  status!: string;
}

// ─── Mission Definition DTOs ──────────────────────────────────────────

export class CreateMissionDto {
  @ApiProperty({ description: 'Unique code for the mission', example: 'WEEKLY_GIFT_MASTER' })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiProperty({ description: 'Display name', example: 'Weekly Gifting Master' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ description: 'Description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: TASK_CATEGORIES })
  @IsEnum(TASK_CATEGORIES)
  category!: string;

  @ApiPropertyOptional({ description: 'Required task count to complete mission', default: 3 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  requiredTaskCount?: number;

  @ApiPropertyOptional({ description: 'Mission completion reward JSON' })
  @IsOptional()
  @IsObject()
  rewardDefinition?: Record<string, any>;
}

// ─── Event Evaluation & Claim DTOs ────────────────────────────────────

export class EvaluateTaskEventDto {
  @ApiProperty({ description: 'User ID' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ description: 'Domain event code', example: 'GIFT_SENT' })
  @IsString()
  @IsNotEmpty()
  eventCode!: string;

  @ApiPropertyOptional({ description: 'Event metadata for rule evaluation', example: { amount: 50 } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class ClaimTaskRewardDto {
  @ApiPropertyOptional({ description: 'Task ID to claim reward for' })
  @IsOptional()
  @IsUUID()
  taskId?: string;

  @ApiPropertyOptional({ description: 'Mission ID to claim reward for' })
  @IsOptional()
  @IsUUID()
  missionId?: string;
}

// ─── Configuration DTO ──────────────────────────────────────────────────

export class UpdateTaskConfigurationDto {
  @ApiProperty({ description: 'Configuration key', example: 'task.daily_reset' })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiProperty({ description: 'Configuration value' })
  value!: any;
}
