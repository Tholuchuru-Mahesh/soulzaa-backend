import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EventType, EventVisibility } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** One event reward (coins / cosmetic / EXP). */
export class EventRewardEntryDto {
  @ApiProperty({ enum: ['COINS', 'COSMETIC', 'EXP'] })
  @IsEnum({ COINS: 'COINS', COSMETIC: 'COSMETIC', EXP: 'EXP' })
  kind!: 'COINS' | 'COSMETIC' | 'EXP';

  @ApiPropertyOptional({ minimum: 1 })
  @ValidateIf((o: EventRewardEntryDto) => o.kind === 'COINS')
  @Type(() => Number)
  @IsInt()
  @Min(1)
  coins?: number;

  @ApiPropertyOptional({ enum: ['GOLD', 'FREE'], default: 'FREE' })
  @IsOptional()
  @IsEnum({ GOLD: 'GOLD', FREE: 'FREE' })
  currency?: 'GOLD' | 'FREE';

  @ApiPropertyOptional()
  @ValidateIf((o: EventRewardEntryDto) => o.kind === 'COSMETIC')
  @IsUUID()
  cosmeticId?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @ValidateIf((o: EventRewardEntryDto) => o.kind === 'EXP')
  @Type(() => Number)
  @IsInt()
  @Min(1)
  exp?: number;
}

/** Optional eligibility gate. */
export class EventEligibilityDto {
  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minUserLevel?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 7 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(7)
  minVipLevel?: number;
}

/** Admin: create an event. */
export class CreateEventDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ enum: EventType })
  @IsEnum(EventType)
  type!: EventType;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ description: 'ISO start timestamp.' })
  @IsDateString()
  startAt!: string;

  @ApiProperty({ description: 'ISO end timestamp.' })
  @IsDateString()
  endAt!: string;

  @ApiPropertyOptional({ enum: EventVisibility, default: EventVisibility.PUBLIC })
  @IsOptional()
  @IsEnum(EventVisibility)
  visibility?: EventVisibility;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ type: [EventRewardEntryDto], description: 'Claimable-event rewards.' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EventRewardEntryDto)
  rewards?: EventRewardEntryDto[];

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 1,
    description: 'DOUBLE_* multiplier.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  multiplier?: number;

  @ApiPropertyOptional({ type: EventEligibilityDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => EventEligibilityDto)
  eligibility?: EventEligibilityDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  bannerUrl?: string;
}

/** Admin: partial update of an event. */
export class UpdateEventDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endAt?: string;

  @ApiPropertyOptional({ enum: EventVisibility })
  @IsOptional()
  @IsEnum(EventVisibility)
  visibility?: EventVisibility;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ type: [EventRewardEntryDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EventRewardEntryDto)
  rewards?: EventRewardEntryDto[];

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  multiplier?: number;

  @ApiPropertyOptional({ type: EventEligibilityDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => EventEligibilityDto)
  eligibility?: EventEligibilityDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  bannerUrl?: string;
}
