import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GiftCategory, GiftContextType, GiftType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import {
  GIFT_LEADERBOARD_MAX_LIMIT,
  GIFT_MAX_QUANTITY,
  LeaderboardBoard,
  LeaderboardPeriod,
  LeaderboardScope,
} from '../constants/gifts.constants';

/** Send a gift to a receiver within a context (e.g. an audio room). */
export class SendGiftDto {
  @ApiProperty()
  @IsUUID()
  giftId!: string;

  @ApiProperty()
  @IsUUID()
  receiverId!: string;

  @ApiProperty({ enum: GiftContextType })
  @IsEnum(GiftContextType)
  contextType!: GiftContextType;

  @ApiProperty({ description: 'The room / stream / conversation id.' })
  @IsUUID()
  contextId!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: GIFT_MAX_QUANTITY, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(GIFT_MAX_QUANTITY)
  quantity = 1;

  @ApiPropertyOptional({
    description: 'Client idempotency key; a replay returns the original send.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;
}

/** Public catalog filter. */
export class ListGiftsDto {
  @ApiPropertyOptional({ enum: GiftCategory })
  @IsOptional()
  @IsEnum(GiftCategory)
  category?: GiftCategory;

  @ApiPropertyOptional({ enum: GiftType })
  @IsOptional()
  @IsEnum(GiftType)
  type?: GiftType;
}

/** Gift history filter (sent + received, optionally scoped to a context). */
export class GiftHistoryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Scope to a single room/stream/conversation.' })
  @IsOptional()
  @IsUUID()
  contextId?: string;
}

/** Leaderboard read (top gifters / receivers, by period + scope). */
export class LeaderboardQueryDto {
  @ApiProperty({ enum: LeaderboardBoard })
  @IsEnum(LeaderboardBoard)
  board!: LeaderboardBoard;

  @ApiProperty({ enum: LeaderboardScope })
  @IsEnum(LeaderboardScope)
  scope!: LeaderboardScope;

  @ApiProperty({ enum: LeaderboardPeriod })
  @IsEnum(LeaderboardPeriod)
  period!: LeaderboardPeriod;

  @ApiPropertyOptional({ description: 'Required when scope=ROOM: the room/context id.' })
  @ValidateIf((o: LeaderboardQueryDto) => o.scope === LeaderboardScope.ROOM)
  @IsUUID()
  contextId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: GIFT_LEADERBOARD_MAX_LIMIT, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(GIFT_LEADERBOARD_MAX_LIMIT)
  limit = 50;
}

/** Admin: create a catalog gift. */
export class CreateGiftDto {
  @ApiProperty({ maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiProperty({ enum: GiftCategory })
  @IsEnum(GiftCategory)
  category!: GiftCategory;

  @ApiProperty({ enum: GiftType })
  @IsEnum(GiftType)
  type!: GiftType;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  coinValue!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  thumbnailUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  animationUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  soundUrl?: string;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minVipLevel?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  comboEnabled?: boolean;

  @ApiPropertyOptional({ minimum: 1, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  comboWindowSeconds?: number;

  @ApiPropertyOptional({ type: [Number], description: 'Lucky multiplier pool (LUCKY gifts).' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  luckyMultipliers?: number[];

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 10000,
    description: 'Lucky win chance (basis points).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  luckyWinChanceBp?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  festivalTag?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

/** Admin: partial update of a catalog gift. */
export class UpdateGiftDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ enum: GiftCategory })
  @IsOptional()
  @IsEnum(GiftCategory)
  category?: GiftCategory;

  @ApiPropertyOptional({ enum: GiftType })
  @IsOptional()
  @IsEnum(GiftType)
  type?: GiftType;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  coinValue?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  thumbnailUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  animationUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  soundUrl?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minVipLevel?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  comboEnabled?: boolean;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  comboWindowSeconds?: number;

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  luckyMultipliers?: number[];

  @ApiPropertyOptional({ minimum: 0, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  luckyWinChanceBp?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  festivalTag?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

/** Admin catalog listing. */
export class ListGiftsAdminDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: GiftCategory })
  @IsOptional()
  @IsEnum(GiftCategory)
  category?: GiftCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  enabled?: boolean;
}
