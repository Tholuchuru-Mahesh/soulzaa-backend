import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GameCode, GameMode, GameTeam } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

/** Host creates a lobby for a game at a chosen stake. */
export class CreateLobbyDto {
  @ApiProperty({ enum: GameCode })
  @IsEnum(GameCode)
  gameCode!: GameCode;

  @ApiProperty({
    description: 'Entry stake per player (game currency). 0 = friendly (no-stake) match.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stake!: number;

  @ApiPropertyOptional({ description: 'Audio-room the game is played inside.' })
  @IsOptional()
  @IsUUID('4')
  roomId?: string;

  @ApiPropertyOptional({
    enum: GameMode,
    description: 'Play mode (default CLASSIC; TEAM_2V2 splits four players into two teams).',
  })
  @IsOptional()
  @IsEnum(GameMode)
  mode?: GameMode;

  @ApiPropertyOptional({
    description: 'Hide the lobby from the public browse (join by code only).',
  })
  @IsOptional()
  @IsBoolean()
  isPrivate?: boolean;

  @ApiPropertyOptional({ description: 'Optional join password (stored hashed).' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  password?: string;

  @ApiPropertyOptional({ description: 'Carrom mode: "classic" or "open_score".' })
  @IsOptional()
  @IsString()
  carromMode?: string;

  @ApiPropertyOptional({
    description: 'Carrom team coin assignment: "team_a_white" or "team_a_black".',
  })
  @IsOptional()
  @IsString()
  teamCoinAssignment?: string;
}

/** Optional password when joining a gated lobby. */
export class JoinLobbyDto {
  @ApiPropertyOptional({ description: 'Lobby password, if the lobby is password-gated.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  password?: string;
}

/** Host kicks a member from their lobby. */
export class KickMemberDto {
  @ApiProperty({ description: 'User id of the member to remove.' })
  @IsUUID('4')
  userId!: string;
}

/** Host edits open-lobby settings (all optional). */
export class UpdateLobbySettingsDto {
  @ApiPropertyOptional({ description: 'New entry stake per player (0 = friendly).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stake?: number;

  @ApiPropertyOptional({ description: 'New max player cap.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  maxPlayers?: number;

  @ApiPropertyOptional({ description: 'Set/replace the join password ("" clears it).' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  password?: string;

  @ApiPropertyOptional({ description: 'Carrom mode: "classic" or "open_score".' })
  @IsOptional()
  @IsString()
  carromMode?: string;

  @ApiPropertyOptional({
    description: 'Carrom team coin assignment: "team_a_white" or "team_a_black".',
  })
  @IsOptional()
  @IsString()
  teamCoinAssignment?: string;
}

/** Join the matchmaking queue for a game at a stake, as a DUEL (2) or TEAM_2V2 (4). */
export class JoinQueueDto {
  @ApiProperty({ enum: GameCode })
  @IsEnum(GameCode)
  gameCode!: GameCode;

  @ApiProperty({
    description: 'Entry stake per player (game currency). 0 = friendly (no-stake) match.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stake!: number;

  @ApiProperty({ enum: ['DUEL', 'TEAM_2V2'], description: 'DUEL pairs 2; TEAM_2V2 pairs 4.' })
  @IsIn(['DUEL', 'TEAM_2V2'])
  matchType!: 'DUEL' | 'TEAM_2V2';
}

/** Pick a team in a TEAM_2V2 lobby. */
export class SetPlayerTeamDto {
  @ApiProperty({ enum: GameTeam })
  @IsEnum(GameTeam)
  team!: GameTeam;
}

/** Toggle a member's ready state in a lobby. */
export class SetReadyDto {
  @ApiProperty({ description: 'true = ready, false = not ready.' })
  @IsBoolean()
  isReady!: boolean;
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

/** A board-game move relayed in-session (opaque per-game envelope; not rule-validated). */
export class SubmitMoveDto {
  @ApiProperty({ description: 'Opaque per-game move payload (action + fields).' })
  @IsObject()
  moveData!: Record<string, unknown>;

  @ApiPropertyOptional({
    description: "Bot seat id — the host relays a move on the bot's behalf (host only).",
  })
  @IsOptional()
  @IsUUID('4')
  onBehalfOf?: string;
}

/** Host adds a bot seat to a lobby. */
export class AddBotDto {
  @ApiPropertyOptional({ description: 'Bot display name (auto-generated if omitted).' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  name?: string;

  @ApiPropertyOptional({ enum: GameTeam, description: 'Team for the bot in a 2v2 lobby.' })
  @IsOptional()
  @IsEnum(GameTeam)
  team?: GameTeam;
}

/**
 * Host-reported match result for a board game. The host reports only the
 * winner(s); the platform derives the pot-share payout server-side and settles
 * (escrow-bounded — a client never sends an amount).
 */
export class ReportMatchResultDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'Winning participant user ids (CLASSIC mode).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsUUID('4', { each: true })
  winners?: string[];

  @ApiPropertyOptional({
    enum: GameTeam,
    description: 'Winning team (required for a TEAM_2V2 session; expanded to both members).',
  })
  @IsOptional()
  @IsEnum(GameTeam)
  winningTeam?: GameTeam;

  @ApiPropertyOptional({
    description: 'Opaque result payload (scoreboard/reason) stored for audit.',
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
