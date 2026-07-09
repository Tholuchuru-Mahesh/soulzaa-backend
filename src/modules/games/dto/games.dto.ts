import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GameCode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

/** Host creates a lobby for a game at a chosen stake. */
export class CreateLobbyDto {
  @ApiProperty({ enum: GameCode })
  @IsEnum(GameCode)
  gameCode!: GameCode;

  @ApiProperty({ description: 'Entry stake per player (game currency).' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  stake!: number;

  @ApiPropertyOptional({ description: 'Audio-room the game is played inside.' })
  @IsOptional()
  @IsUUID('4')
  roomId?: string;
}

/** One player's payout in a settlement submission. */
export class PayoutEntryDto {
  @ApiProperty()
  @IsUUID('4')
  userId!: string;

  @ApiProperty({ description: 'Coins credited to this player (>= 0).' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amount!: number;
}

/**
 * Trusted result submission. The game engine decides winners/payouts; the
 * platform validates and settles. `winners` must be a subset of participants,
 * and total payouts must not exceed the escrowed pot.
 */
export class SettleResultDto {
  @ApiProperty({ type: [String], description: 'Winning participant user ids.' })
  @IsArray()
  @ArrayMaxSize(64)
  @IsUUID('4', { each: true })
  winners!: string[];

  @ApiProperty({ type: [PayoutEntryDto], description: 'Per-player payouts.' })
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => PayoutEntryDto)
  payouts!: PayoutEntryDto[];

  @ApiPropertyOptional({
    description: 'Opaque result payload (scoreboard/seed/proof) stored for audit.',
  })
  @IsOptional()
  @IsObject()
  resultData?: Record<string, unknown>;
}

/** Paginated session/match-history filter. */
export class ListSessionsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: GameCode })
  @IsOptional()
  @IsEnum(GameCode)
  gameCode?: GameCode;
}

/** Admin edit of a game catalog entry (all fields optional). */
export class UpdateGameDefinitionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minPlayers?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  maxPlayers?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minStake?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxStake?: number;

  @ApiPropertyOptional({ description: 'House cut in basis points (0-10000).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  houseRakeBps?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** Leaderboard query. */
export class GameLeaderboardDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
