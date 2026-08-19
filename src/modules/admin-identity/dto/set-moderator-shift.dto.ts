import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DayOfWeek } from '@prisma/client';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** Assigns or updates a Moderator's working shift. */
export class SetModeratorShiftDto {
  @ApiProperty({ example: 9, minimum: 0, maximum: 23 })
  @IsInt()
  @Min(0)
  @Max(23)
  shiftStartHour!: number;

  @ApiProperty({ example: 0, minimum: 0, maximum: 59 })
  @IsInt()
  @Min(0)
  @Max(59)
  shiftStartMinute!: number;

  @ApiProperty({ example: 15, minimum: 0, maximum: 23 })
  @IsInt()
  @Min(0)
  @Max(23)
  shiftEndHour!: number;

  @ApiProperty({ example: 0, minimum: 0, maximum: 59 })
  @IsInt()
  @Min(0)
  @Max(59)
  shiftEndMinute!: number;

  @ApiPropertyOptional({
    enum: DayOfWeek,
    isArray: true,
    description: 'Defaults to all 7 days when omitted',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(DayOfWeek, { each: true })
  shiftDaysOfWeek?: DayOfWeek[];

  @ApiPropertyOptional({ example: 'UTC', description: 'Defaults to UTC when omitted' })
  @IsOptional()
  @IsString()
  shiftTimezone?: string;
}
