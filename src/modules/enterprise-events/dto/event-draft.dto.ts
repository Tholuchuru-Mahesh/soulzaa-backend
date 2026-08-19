import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Body of `POST /enterprise-events/drafts`. Note there is no `status` field:
 * the status is the server's to decide, never the client's.
 */
export class CreateEventDraftDto {
  @ApiProperty({ example: 'Super Star Singing Battle' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ description: 'S3 object key from /storage/confirm' })
  @IsOptional()
  @IsString()
  banner?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  thumbnail?: string;

  @ApiProperty({ description: 'Event start (ISO 8601)' })
  @IsDateString()
  startTime!: string;

  @ApiProperty({ description: 'Event end (ISO 8601)' })
  @IsDateString()
  endTime!: string;

  @ApiProperty({ description: 'Registration opens (ISO 8601)' })
  @IsDateString()
  regStartTime!: string;

  @ApiProperty({ description: 'Registration closes (ISO 8601)' })
  @IsDateString()
  regEndTime!: string;

  @ApiPropertyOptional({ default: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxParticipants?: number;

  @ApiPropertyOptional({ description: 'Entry, limits, rules, point rules, challenges' })
  @IsOptional()
  @IsObject()
  participationRules?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Level, followers, account age, verification, age, country' })
  @IsOptional()
  @IsObject()
  eligibilityRules?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Prize pool, tiers, participation reward' })
  @IsOptional()
  @IsObject()
  rewardDefinition?: Record<string, unknown>;
}

/** Body of `PATCH /enterprise-events/drafts/:id`. Every field optional. */
export class UpdateEventDraftDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

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
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxParticipants?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  participationRules?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  eligibilityRules?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  rewardDefinition?: Record<string, unknown>;
}
