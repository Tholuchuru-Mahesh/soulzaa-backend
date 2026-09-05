import { VideoRoomPkMode } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * VR-12 PK battle DTOs.
 *
 * Per-field validation only. Cross-field rules — RED/BLUE overlap, per-side
 * cardinality for ONE_VS_ONE — are business rules that need room context, so
 * they live in the validation service (Task 12), not here. A payload with the
 * same user on both sides is well-formed at the DTO layer even though the
 * service will reject it.
 *
 * Review fix (Task 24): a separate `invitees` field used to exist here, but
 * `VideoRoomPkService.invite` has always derived the invitee list entirely
 * from `red`/`blue` (everyone on either side must accept before the battle
 * may start) and never read it — a client sending it got a silently
 * different set of invitees than the one they actually asked for. Removed
 * rather than honoured: `red ∪ blue` already carries every bit of
 * information the field could add, so wiring it up would only introduce a
 * second, redundant way to say the same thing.
 */
export class CreatePKInvitationDto {
  @ApiProperty({ enum: VideoRoomPkMode, example: VideoRoomPkMode.ONE_VS_ONE })
  @IsEnum(VideoRoomPkMode)
  mode!: VideoRoomPkMode;

  /**
   * These `@Min`/`@Max` are a cheap first-pass guard only — a malformed
   * payload is rejected before it does any I/O. The AUTHORITATIVE bounds are
   * `videoRoomPk.minDurationSeconds`/`maxDurationSeconds`, enforced against
   * live config in `VideoRoomPkValidationService.assertCanCreate`. Do not
   * treat these two checks as redundant: an operator who raises
   * `VIDEO_ROOM_PK_MAX_DURATION_SECONDS` past 1800 must see that value
   * actually take effect, which only the service-level check can do.
   *
   * Optional: when omitted, `VideoRoomPkService.invite` falls back to
   * `videoRoomPk.defaultDurationSeconds`.
   */
  @ApiPropertyOptional({ example: 300, minimum: 60, maximum: 1800 })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(1800)
  durationSeconds?: number;

  @ApiProperty({ type: [String], description: 'User ids on the RED side' })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  red!: string[];

  @ApiProperty({ type: [String], description: 'User ids on the BLUE side' })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  blue!: string[];
}

export class AcceptPKInvitationDto {
  @ApiPropertyOptional({
    description:
      "Battle to accept into. When absent, the service resolves the room's current battle.",
  })
  @IsOptional()
  @IsUUID('4')
  battleId?: string;
}

export class RejectPKInvitationDto {
  @ApiPropertyOptional({
    description: "Battle to reject. When absent, the service resolves the room's current battle.",
  })
  @IsOptional()
  @IsUUID('4')
  battleId?: string;
}

export class StartPKDto {
  @ApiPropertyOptional({ example: 10, minimum: 3, maximum: 60 })
  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(60)
  countdownSeconds?: number;
}

export class PausePKDto {
  @ApiPropertyOptional({ example: 'network issue', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class ResumePKDto {
  @ApiPropertyOptional({ example: 'resolved', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class EndPKDto {
  @ApiPropertyOptional({ example: 'owner ended early', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class PKHistoryQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100, example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class PKScoreDto {
  @ApiProperty({ example: 'b3f1c2d4-...' }) teamId!: string;
  @ApiProperty({ enum: ['RED', 'BLUE'] }) side!: string;
  @ApiProperty({ example: 1500 }) score!: number;
}

export class PKStatisticsDto {
  @ApiProperty({ example: 12, description: 'Battles fought in this room, all time.' })
  totalBattles!: number;
  @ApiProperty({ example: 9 }) totalWins!: number;
  @ApiProperty({ example: 2 }) totalDraws!: number;
  @ApiProperty({ example: 45000, description: 'Coins contributed across all battles.' })
  totalContributed!: number;
  @ApiProperty({ example: 320 }) totalGiftCount!: number;
}

export class PKParticipantView {
  @ApiProperty({ example: 'b3f1c2d4-...' }) userId!: string;
  @ApiProperty({ example: 'b3f1c2d4-...' }) teamId!: string;
  @ApiProperty({ enum: ['RED', 'BLUE'] }) side!: string;
  @ApiProperty({ example: 150 }) score!: number;
  @ApiProperty({ example: 3 }) giftCount!: number;
}

export class PKResponseDto {
  @ApiProperty({ example: true }) active!: boolean;
  @ApiPropertyOptional({ example: 'a91c7b2e-...' }) id?: string;
  @ApiPropertyOptional({ example: 'd4e5f6a7-...' }) roomId?: string;
  @ApiPropertyOptional({ enum: VideoRoomPkMode }) mode?: VideoRoomPkMode;
  @ApiPropertyOptional({
    enum: [
      'CREATED',
      'INVITED',
      'PENDING',
      'ACCEPTED',
      'COUNTDOWN',
      'LIVE',
      'PAUSED',
      'RECOVERING',
      'COMPLETED',
      'CANCELLED',
      'FAILED',
    ],
  })
  status?: string;
  @ApiPropertyOptional({ example: 10 }) countdownSeconds?: number;
  @ApiPropertyOptional({ example: 300 }) durationSeconds?: number;
  @ApiPropertyOptional({ nullable: true, example: '2026-07-22T10:00:00.000Z' })
  startedAt?: string | null;
  @ApiPropertyOptional({ nullable: true, example: '2026-07-22T10:05:00.000Z' })
  endsAt?: string | null;
  @ApiProperty({ example: '2026-07-22T10:02:00.000Z' }) serverTime!: string;
  @ApiPropertyOptional({ example: false }) isDraw?: boolean;
  @ApiPropertyOptional({ nullable: true, example: null }) winningTeamId?: string | null;
  @ApiPropertyOptional({ type: [PKScoreDto] }) teams?: PKScoreDto[];
  @ApiPropertyOptional({ example: 1500 }) redScore?: number;
  @ApiPropertyOptional({ example: 1200 }) blueScore?: number;
  @ApiPropertyOptional({ example: 'b3f1c2d4-...' }) challengerUserId?: string;
  @ApiPropertyOptional({
    type: [PKParticipantView],
    description: 'Per-participant score breakdown.',
  })
  participants?: PKParticipantView[];
}

