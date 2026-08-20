import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateChallengeDto {
  @ApiProperty({ example: 'Daily Login Streak' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  shortDescription?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ default: 'Daily' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  coverImage?: string;

  @ApiPropertyOptional({ default: 'Login Streak' })
  @IsOptional()
  @IsString()
  challengeType?: string;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetValue?: number;

  @ApiPropertyOptional({ default: 'Days' })
  @IsOptional()
  @IsString()
  targetUnit?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isMultiTask?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  allTasksRequired?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  tasks?: any[];

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
  @IsDateString()
  startTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endTime?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  recurrenceConfig?: Record<string, any>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  eligibilityRules?: Record<string, any>;

  @ApiPropertyOptional({ default: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  maxParticipants?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  minParticipants?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  rewardDefinition?: Record<string, any>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  rules?: any[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  antiCheat?: Record<string, any>;
}

export class UpdateChallengeDto extends CreateChallengeDto {}

export class RejectChallengeDto {
  @ApiProperty({ example: 'Inappropriate challenge content' })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
