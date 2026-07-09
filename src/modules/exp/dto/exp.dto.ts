import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
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

/** One level reward (free/gold coins or a catalog cosmetic). */
export class RewardEntryDto {
  @ApiProperty({ enum: ['COINS', 'COSMETIC'] })
  @IsEnum({ COINS: 'COINS', COSMETIC: 'COSMETIC' })
  kind!: 'COINS' | 'COSMETIC';

  @ApiPropertyOptional({ minimum: 1 })
  @ValidateIf((o: RewardEntryDto) => o.kind === 'COINS')
  @Type(() => Number)
  @IsInt()
  @Min(1)
  coins?: number;

  @ApiPropertyOptional({ enum: ['GOLD', 'FREE'], default: 'FREE' })
  @IsOptional()
  @IsEnum({ GOLD: 'GOLD', FREE: 'FREE' })
  currency?: 'GOLD' | 'FREE';

  @ApiPropertyOptional({ description: 'Catalog cosmetic id (kind=COSMETIC).' })
  @ValidateIf((o: RewardEntryDto) => o.kind === 'COSMETIC')
  @IsUUID()
  cosmeticId?: string;
}

/** Admin: create/replace a user level config. */
export class LevelConfigDto {
  @ApiProperty({ minimum: 1, maximum: 1000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  level!: number;

  @ApiProperty({ minimum: 0, description: 'Cumulative EXP to reach this level.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minExp!: number;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string;

  @ApiPropertyOptional({ type: [RewardEntryDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RewardEntryDto)
  rewards?: RewardEntryDto[];
}

/** Admin: create/replace a room level config. */
export class RoomLevelConfigDto {
  @ApiProperty({ minimum: 1, maximum: 1000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  level!: number;

  @ApiProperty({ minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minExp!: number;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string;
}

/** Admin: award EXP to a user manually. */
export class AwardExpDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount!: number;
}
