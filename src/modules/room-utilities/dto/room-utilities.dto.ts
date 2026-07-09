import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RandomPickPool } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsHexColor,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  COUNTDOWN_LABEL_MAX,
  COUNTDOWN_MAX_SECONDS,
  COUNTDOWN_MIN_SECONDS,
  DICE_MAX_COUNT,
  DICE_MIN_COUNT,
  POLL_MAX_OPTIONS,
  POLL_MAX_DURATION_SECONDS,
  POLL_MIN_OPTIONS,
  POLL_MIN_DURATION_SECONDS,
  POLL_OPTION_LABEL_MAX,
  POLL_QUESTION_MAX,
  RANDOM_PICK_MAX,
  RANDOM_PICK_MIN,
  SPIN_MAX_SEGMENTS,
  SPIN_MIN_SEGMENTS,
  SPIN_SEGMENT_LABEL_MAX,
  SPIN_SEGMENT_MAX_REWARD,
  SPIN_SEGMENT_MAX_WEIGHT,
  SPIN_TITLE_MAX,
} from '../constants/room-utilities.constants';

// ---- Polls ----

export class CreatePollDto {
  @ApiProperty({ maxLength: POLL_QUESTION_MAX })
  @IsString()
  @Length(1, POLL_QUESTION_MAX)
  question!: string;

  @ApiProperty({ type: [String], minItems: POLL_MIN_OPTIONS, maxItems: POLL_MAX_OPTIONS })
  @IsArray()
  @ArrayMinSize(POLL_MIN_OPTIONS)
  @ArrayMaxSize(POLL_MAX_OPTIONS)
  @IsString({ each: true })
  @Length(1, POLL_OPTION_LABEL_MAX, { each: true })
  options!: string[];

  @ApiPropertyOptional({
    minimum: POLL_MIN_DURATION_SECONDS,
    maximum: POLL_MAX_DURATION_SECONDS,
    description: 'Auto-end the poll after this many seconds.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(POLL_MIN_DURATION_SECONDS)
  @Max(POLL_MAX_DURATION_SECONDS)
  durationSeconds?: number;
}

export class VotePollDto {
  @ApiProperty({ format: 'uuid' })
  @IsString()
  optionId!: string;
}

// ---- Dice ----

export class RollDiceDto {
  @ApiPropertyOptional({ minimum: DICE_MIN_COUNT, maximum: DICE_MAX_COUNT, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(DICE_MIN_COUNT)
  @Max(DICE_MAX_COUNT)
  diceCount?: number;
}

// ---- Random picker ----

export class RandomPickDto {
  @ApiProperty({ enum: RandomPickPool })
  @IsEnum(RandomPickPool)
  pool!: RandomPickPool;

  @ApiPropertyOptional({ minimum: RANDOM_PICK_MIN, maximum: RANDOM_PICK_MAX })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(RANDOM_PICK_MIN)
  @Max(RANDOM_PICK_MAX)
  rangeMin?: number;

  @ApiPropertyOptional({ minimum: RANDOM_PICK_MIN, maximum: RANDOM_PICK_MAX })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(RANDOM_PICK_MIN)
  @Max(RANDOM_PICK_MAX)
  rangeMax?: number;
}

// ---- Spin wheel ----

export class SpinSegmentDto {
  @ApiProperty({ maxLength: SPIN_SEGMENT_LABEL_MAX })
  @IsString()
  @Length(1, SPIN_SEGMENT_LABEL_MAX)
  label!: string;

  @ApiProperty({ minimum: 1, maximum: SPIN_SEGMENT_MAX_WEIGHT })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SPIN_SEGMENT_MAX_WEIGHT)
  weight!: number;

  @ApiPropertyOptional({ description: 'Hex color for the segment.' })
  @IsOptional()
  @IsHexColor()
  color?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: SPIN_SEGMENT_MAX_REWARD })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SPIN_SEGMENT_MAX_REWARD)
  rewardCoins?: number;
}

export class CreateSpinWheelDto {
  @ApiProperty({ maxLength: SPIN_TITLE_MAX })
  @IsString()
  @Length(1, SPIN_TITLE_MAX)
  title!: string;

  @ApiProperty({ type: [SpinSegmentDto], minItems: SPIN_MIN_SEGMENTS, maxItems: SPIN_MAX_SEGMENTS })
  @IsArray()
  @ArrayMinSize(SPIN_MIN_SEGMENTS)
  @ArrayMaxSize(SPIN_MAX_SEGMENTS)
  @ValidateNested({ each: true })
  @Type(() => SpinSegmentDto)
  segments!: SpinSegmentDto[];
}

// ---- Countdown ----

export class StartCountdownDto {
  @ApiPropertyOptional({ maxLength: COUNTDOWN_LABEL_MAX })
  @IsOptional()
  @IsString()
  @Length(1, COUNTDOWN_LABEL_MAX)
  label?: string;

  @ApiProperty({ minimum: COUNTDOWN_MIN_SECONDS, maximum: COUNTDOWN_MAX_SECONDS })
  @Type(() => Number)
  @IsInt()
  @Min(COUNTDOWN_MIN_SECONDS)
  @Max(COUNTDOWN_MAX_SECONDS)
  durationSeconds!: number;
}
