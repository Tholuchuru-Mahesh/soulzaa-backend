import { ApiProperty } from '@nestjs/swagger';
import { PkMode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { PK_MAX_TEAM_SIZE } from '../constants/pk.constants';

/** Start a PK battle with participants assigned to RED and BLUE sides. */
export class StartPkDto {
  @ApiProperty({ enum: PkMode })
  @IsEnum(PkMode)
  mode!: PkMode;

  @ApiProperty({ minimum: 30, maximum: 3600, description: 'Battle duration (seconds).' })
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(3600)
  durationSeconds!: number;

  @ApiProperty({ type: [String], description: 'RED side participant user ids.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PK_MAX_TEAM_SIZE)
  @IsUUID('4', { each: true })
  red!: string[];

  @ApiProperty({ type: [String], description: 'BLUE side participant user ids.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PK_MAX_TEAM_SIZE)
  @IsUUID('4', { each: true })
  blue!: string[];
}
