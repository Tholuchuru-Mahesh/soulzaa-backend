import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CallEndReason, CallType } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

/**
 * The history-screen filter chips. Resolved server-side: filtering a *page* of 20
 * rows down to 3 on the client makes both the list and its counts lie.
 */
export const CALL_HISTORY_FILTERS = ['ALL', 'INCOMING', 'OUTGOING', 'MISSED'] as const;

export type CallHistoryFilterValue = (typeof CALL_HISTORY_FILTERS)[number];

export class InitiateCallDto {
  @ApiProperty({ description: 'The user to call' })
  @IsUUID()
  calleeId!: string;

  @ApiProperty({ enum: CallType, description: 'VOICE or VIDEO' })
  @IsEnum(CallType)
  type!: CallType;

  @ApiProperty({
    description:
      'Caller-generated idempotency key. Makes the call button retry-safe: a double-tap, ' +
      'or a resend after a flaky network, resolves to the same call instead of ringing twice.',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  clientId!: string;
}

/**
 * Why the client could not hold the session up. Deliberately a closed set, and
 * deliberately *not* every CallEndReason: a client may report a media/network
 * failure, but it may not declare a call TIMEOUT or BUSY — those are the server's
 * to decide, and letting a client assert them would let it rewrite history.
 */
export const CLIENT_FAILURE_REASONS = [
  CallEndReason.NETWORK,
  CallEndReason.FAILED,
] as const satisfies readonly CallEndReason[];

export class FailCallDto {
  @ApiProperty({
    enum: CLIENT_FAILURE_REASONS,
    description: 'NETWORK when media was lost past recovery; FAILED for an unrecoverable SDK error',
  })
  @IsIn(CLIENT_FAILURE_REASONS)
  reason!: (typeof CLIENT_FAILURE_REASONS)[number];
}

export class ListCallsDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: CALL_HISTORY_FILTERS,
    default: 'ALL',
    description:
      'ALL = every call either way; INCOMING = calls placed to this user; OUTGOING = calls this ' +
      'user placed; MISSED = inbound calls that went unanswered (or found this user busy)',
  })
  @IsOptional()
  @IsEnum(CALL_HISTORY_FILTERS)
  filter: CallHistoryFilterValue = 'ALL';

  @ApiPropertyOptional({ description: 'Filter by peer username or full name' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;
}
