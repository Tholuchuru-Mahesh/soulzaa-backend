import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ModerationBanType, ModerationMuteType, ReportReason, ReportStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
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
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import {
  MOD_DURATION_MAX_MINUTES,
  MOD_DURATION_MIN_MINUTES,
  MOD_NOTE_MAX,
  MOD_REASON_MAX,
} from '../constants/moderation.constants';

/** Kick a user out of the room now (they may rejoin unless also banned). */
export class KickDto {
  @ApiPropertyOptional({ maxLength: MOD_REASON_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(MOD_REASON_MAX)
  reason?: string;
}

/** Ban a user. TEMPORARY requires `durationMinutes`; PERMANENT ignores it. */
export class BanDto {
  @ApiProperty({ enum: ModerationBanType })
  @IsEnum(ModerationBanType)
  type!: ModerationBanType;

  @ApiPropertyOptional({ maxLength: MOD_REASON_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(MOD_REASON_MAX)
  reason?: string;

  @ApiPropertyOptional({ minimum: MOD_DURATION_MIN_MINUTES, maximum: MOD_DURATION_MAX_MINUTES })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MOD_DURATION_MIN_MINUTES)
  @Max(MOD_DURATION_MAX_MINUTES)
  durationMinutes?: number;
}

/** Mute a member. PERMANENT = until manually removed. */
export class MuteDto {
  @ApiProperty({ enum: ModerationMuteType })
  @IsEnum(ModerationMuteType)
  type!: ModerationMuteType;

  @ApiPropertyOptional({ maxLength: MOD_REASON_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(MOD_REASON_MAX)
  reason?: string;

  @ApiPropertyOptional({ minimum: MOD_DURATION_MIN_MINUTES, maximum: MOD_DURATION_MAX_MINUTES })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MOD_DURATION_MIN_MINUTES)
  @Max(MOD_DURATION_MAX_MINUTES)
  durationMinutes?: number;
}

/** Issue a warning to a user (no state change, audited + notified). */
export class WarnDto {
  @ApiProperty({ maxLength: MOD_REASON_MAX })
  @IsString()
  @MinLength(1)
  @MaxLength(MOD_REASON_MAX)
  reason!: string;
}

/** Report another user in the room. */
export class ReportDto {
  @ApiProperty()
  @IsUUID()
  targetUserId!: string;

  @ApiProperty({ enum: ReportReason })
  @IsEnum(ReportReason)
  reason!: ReportReason;

  @ApiPropertyOptional({ maxLength: MOD_REASON_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(MOD_REASON_MAX)
  description?: string;
}

/** Moderator resolution of a report. */
export class ReviewReportDto {
  @ApiProperty({ enum: [ReportStatus.REVIEWED, ReportStatus.DISMISSED, ReportStatus.ACTIONED] })
  @IsEnum(ReportStatus)
  status!: ReportStatus;

  @ApiPropertyOptional({ maxLength: MOD_REASON_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(MOD_REASON_MAX)
  resolution?: string;

  @ApiPropertyOptional({ enum: ['WARNING', 'MUTE', 'KICK', 'BAN'] })
  @IsOptional()
  @IsString()
  @IsIn(['WARNING', 'MUTE', 'KICK', 'BAN'])
  recommendedAction?: 'WARNING' | 'MUTE' | 'KICK' | 'BAN';
}

/** Add a moderator note about a user. */
export class AddNoteDto {
  @ApiProperty()
  @IsUUID()
  targetUserId!: string;

  @ApiProperty({ maxLength: MOD_NOTE_MAX })
  @IsString()
  @MinLength(1)
  @MaxLength(MOD_NOTE_MAX)
  note!: string;
}

/** A user's appeal against an active ban or mute (exactly one of banId/muteId). */
export class AppealDto {
  @ApiPropertyOptional({ description: 'The ban being appealed (or provide muteId).' })
  @IsOptional()
  @IsUUID()
  banId?: string;

  @ApiPropertyOptional({ description: 'The mute being appealed (or provide banId).' })
  @IsOptional()
  @IsUUID()
  muteId?: string;

  @ApiProperty({ maxLength: MOD_REASON_MAX })
  @IsString()
  @MinLength(1)
  @MaxLength(MOD_REASON_MAX)
  reason!: string;
}

/** Moderator decision on an appeal. */
export class ResolveAppealDto {
  @ApiProperty({ description: 'Approve (lift the action) or reject the appeal.' })
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional({ maxLength: MOD_REASON_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(MOD_REASON_MAX)
  decisionNote?: string;
}

/** Filters for paginated moderation-log listings. */
export class ListModerationDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by target user id.' })
  @IsOptional()
  @IsUUID()
  targetUserId?: string;
}
