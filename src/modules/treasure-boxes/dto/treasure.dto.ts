import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BackpackItemType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
import { TREASURE_BOX_COUNT } from '../constants/treasure.constants';

/** One reward in a box/rocket reward list (COINS or BACKPACK_ITEM at a rank). */
export class RewardEntryDto {
  @ApiProperty({ minimum: 1, maximum: 10, description: 'Which Top rank receives this reward.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  rank!: number;

  @ApiProperty({ enum: ['COINS', 'BACKPACK_ITEM'] })
  @IsEnum({ COINS: 'COINS', BACKPACK_ITEM: 'BACKPACK_ITEM' })
  kind!: 'COINS' | 'BACKPACK_ITEM';

  @ApiPropertyOptional({ minimum: 1, description: 'Gold coins (kind=COINS).' })
  @ValidateIf((o: RewardEntryDto) => o.kind === 'COINS')
  @Type(() => Number)
  @IsInt()
  @Min(1)
  coins?: number;

  @ApiPropertyOptional({ enum: BackpackItemType, description: 'Item type (kind=BACKPACK_ITEM).' })
  @ValidateIf((o: RewardEntryDto) => o.kind === 'BACKPACK_ITEM')
  @IsEnum(BackpackItemType)
  itemType?: BackpackItemType;

  @ApiPropertyOptional({ description: 'Item display name (kind=BACKPACK_ITEM).' })
  @ValidateIf((o: RewardEntryDto) => o.kind === 'BACKPACK_ITEM')
  @IsString()
  @MaxLength(80)
  itemName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  itemRefId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  transferable?: boolean;
}

/** Admin: create/replace a treasure box level config (level 1..5). */
export class TreasureConfigDto {
  @ApiProperty({ minimum: 1, maximum: TREASURE_BOX_COUNT })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TREASURE_BOX_COUNT)
  level!: number;

  @ApiProperty({ minimum: 1, description: 'Gift value required to open this box.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threshold!: number;

  @ApiProperty({ type: [RewardEntryDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RewardEntryDto)
  rewards!: RewardEntryDto[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** Admin: create/replace a rocket config keyed by the trigger gift. */
export class RocketConfigDto {
  @ApiProperty({ description: 'The premium gift whose send triggers the rocket.' })
  @IsUUID()
  triggerGiftId!: string;

  @ApiProperty({ minimum: 5, maximum: 3600, default: 60 })
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(3600)
  durationSeconds!: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  priority?: number;

  @ApiProperty({ type: [RewardEntryDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RewardEntryDto)
  rewardPool!: RewardEntryDto[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
