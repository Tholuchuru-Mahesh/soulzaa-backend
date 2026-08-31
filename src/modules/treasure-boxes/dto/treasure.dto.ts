import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BackpackItemType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
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

/**
 * The backpack item types a treasure box / rocket may award. Restricted to the
 * equippable cosmetic kinds the Super Admin panel exposes — room themes, entry
 * effects and profile frames. Every one must resolve to an existing enabled
 * `Cosmetic` (see `itemRefId`); nothing is a free-text placeholder.
 */
export const TREASURE_REWARD_ITEM_TYPES = [
  BackpackItemType.FRAME,
  BackpackItemType.THEME,
  BackpackItemType.ENTRANCE_EFFECT,
] as const;

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

  @ApiPropertyOptional({ minimum: 1, description: 'Free in-game gold coins (kind=COINS).' })
  @ValidateIf((o: RewardEntryDto) => o.kind === 'COINS')
  @Type(() => Number)
  @IsInt()
  @Min(1)
  coins?: number;

  @ApiPropertyOptional({
    enum: TREASURE_REWARD_ITEM_TYPES,
    description: 'Equippable cosmetic type (kind=BACKPACK_ITEM).',
  })
  @ValidateIf((o: RewardEntryDto) => o.kind === 'BACKPACK_ITEM')
  @IsIn(TREASURE_REWARD_ITEM_TYPES as readonly string[])
  itemType?: BackpackItemType;

  @ApiPropertyOptional({
    description:
      'Catalog cosmetic id this reward grants (kind=BACKPACK_ITEM). Required — the admin ' +
      'picks an existing asset; the display name is derived from it server-side.',
  })
  @ValidateIf((o: RewardEntryDto) => o.kind === 'BACKPACK_ITEM')
  @IsUUID()
  itemRefId?: string;

  @ApiPropertyOptional({
    description: 'Server-derived display name for the granted cosmetic (ignored on write).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  itemName?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  transferable?: boolean;

  @ApiPropertyOptional({
    minimum: 0,
    default: 0,
    description:
      'Days the granted cosmetic stays with the winner before it expires and is ' +
      'removed. 0 (or omitted) = permanent. Ignored for COINS.',
  })
  @ValidateIf((o: RewardEntryDto) => o.kind === 'BACKPACK_ITEM')
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  ttlDays?: number;
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
