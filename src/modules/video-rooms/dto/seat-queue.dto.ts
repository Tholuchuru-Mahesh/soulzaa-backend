import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsUUID, Max, Min, ValidateIf } from 'class-validator';
import {
  VIDEO_ROOM_MAX_SEATS,
  VIDEO_ROOM_OWNER_SEAT_INDEX,
} from '../constants/video-room.constants';

/** Change the preferred seat on your own pending request (null = any seat). */
export class UpdateSeatRequestDto {
  @ApiPropertyOptional({
    description: 'New preferred seat index, or null for any available seat.',
    minimum: VIDEO_ROOM_OWNER_SEAT_INDEX + 1,
    maximum: VIDEO_ROOM_MAX_SEATS - 1,
    nullable: true,
    example: 3,
  })
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(VIDEO_ROOM_OWNER_SEAT_INDEX + 1, { message: 'The owner seat cannot be requested.' })
  @Max(VIDEO_ROOM_MAX_SEATS - 1)
  seatIndex!: number | null;
}

/** Cancel an outstanding invitation (inviter / owner / admin). */
export class CancelSeatInvitationDto {
  @ApiProperty({ description: 'Invitation to cancel.', format: 'uuid' })
  @IsUUID()
  invitationId!: string;
}

/** The invitee's client confirms it received the invitation. */
export class AckSeatInvitationDto {
  @ApiProperty({ description: 'Invitation being acknowledged.', format: 'uuid' })
  @IsUUID()
  invitationId!: string;
}

/** Re-drive a FAILED invitation's seating. */
export class RetrySeatInvitationDto {
  @ApiProperty({ description: 'Invitation to retry.', format: 'uuid' })
  @IsUUID()
  invitationId!: string;
}

/** One waiting user, as returned by the queue endpoint. */
export class QueueEntryDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ description: '1-based position; 1 is next to be seated.', example: 1 })
  position!: number;

  @ApiProperty({ description: 'VIP tier ordinal (0 = not VIP).', example: 3 })
  vipLevel!: number;
}

/** The room's seat queue plus the caller's own position in it. */
export class QueueResponseDto {
  @ApiProperty({ description: 'Total users waiting.', example: 42 })
  size!: number;

  @ApiProperty({
    type: [QueueEntryDto],
    description: 'The front of the queue, truncated to the preview limit.',
  })
  entries!: QueueEntryDto[];

  @ApiPropertyOptional({
    description: "The caller's own 1-based position, or null if not queued.",
    nullable: true,
    example: 7,
  })
  myPosition!: number | null;
}

/** Result of a promotion (approval, invitation acceptance, or auto-advance). */
export class PromotionResponseDto {
  @ApiProperty({ format: 'uuid' })
  roomId!: string;

  @ApiProperty({ format: 'uuid', description: 'The user who was seated.' })
  userId!: string;

  @ApiProperty({ description: 'Seat they now occupy.', example: 3 })
  seatIndex!: number;

  @ApiProperty({ description: 'Seat-stage version for client reconciliation.', example: 17 })
  version!: number;
}

/** A pending seat request with its queue position, for the moderation list. */
export class SeatRequestListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiPropertyOptional({ nullable: true, description: 'Requested seat, or null for any.' })
  seatIndex!: number | null;

  @ApiProperty({
    enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'PROMOTED', 'FAILED'],
  })
  status!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiPropertyOptional({ nullable: true, description: '1-based queue position.' })
  position!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Requester display identity. Absent when the user could not be resolved ' +
      '(deleted) or identity lookup degraded — clients render a placeholder, never a fake name.',
  })
  user?: {
    displayName: string | null;
    avatarUrl: string | null;
    username?: string;
    level?: number;
    vipLevel?: number;
    verified?: boolean;
  };
}
