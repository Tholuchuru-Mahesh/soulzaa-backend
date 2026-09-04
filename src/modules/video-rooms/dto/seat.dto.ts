import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VideoRoomInvitationType } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
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
} from 'class-validator';
import { VIDEO_ROOM_MAX_SEATS } from '../constants/video-room.constants';

/**
 * Request to take a seat. `seatIndex` omitted ⇒ any available seat. NOTE (VR-1):
 * endpoints return 501 until the seat phase; these DTOs define the contracts.
 */
export class CreateSeatRequestDto {
  @ApiPropertyOptional({ minimum: 0, description: 'A specific seat, or omit for any.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  seatIndex?: number;
}

/** Invite a user onto a seat, or into a (private) room. */
export class CreateVideoRoomInvitationDto {
  @ApiProperty({ description: 'The invited user.' })
  @IsUUID()
  inviteeUserId!: string;

  @ApiPropertyOptional({ enum: VideoRoomInvitationType, default: VideoRoomInvitationType.SEAT })
  @IsOptional()
  @IsEnum(VideoRoomInvitationType)
  type?: VideoRoomInvitationType;

  @ApiPropertyOptional({ minimum: 0, description: 'Target seat for a SEAT invite.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  seatIndex?: number;
}

/** Reserve a specific seat for a specific user (owner/admin), held for a TTL. */
export class ReserveSeatDto {
  @ApiProperty({ minimum: 0, description: 'The seat to hold.' })
  @IsInt()
  @Min(0)
  seatIndex!: number;

  @ApiProperty({ description: 'The user the seat is reserved for.' })
  @IsUUID()
  forUserId!: string;

  @ApiPropertyOptional({
    minimum: 5,
    maximum: 600,
    description: 'Seconds to hold the reservation before auto-release.',
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(600)
  ttlSeconds?: number;
}

/** Cancel an outstanding reservation on a seat. */
export class CancelReservationDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  seatIndex!: number;
}

/** Accept a pending seat invitation. */
export class AcceptSeatInvitationDto {
  @ApiProperty({ description: 'The invitation being accepted.' })
  @IsUUID()
  invitationId!: string;
}

/** Reject a pending seat invitation. */
export class RejectSeatInvitationDto {
  @ApiProperty({ description: 'The invitation being rejected.' })
  @IsUUID()
  invitationId!: string;
}

/** Lock one or more seats (bulk). `reason` supports 'disabled' / 'maintenance'. */
export class LockSeatsDto {
  @ApiProperty({ type: [Number], description: 'The seat indexes to lock.' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(VIDEO_ROOM_MAX_SEATS)
  @IsInt({ each: true })
  @Min(0, { each: true })
  seatIndexes!: number[];

  @ApiPropertyOptional({ description: "Lock reason, e.g. 'disabled' or 'maintenance'." })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  reason?: string;
}

/** Unlock one or more seats (bulk). */
export class UnlockSeatsDto {
  @ApiProperty({ type: [Number], description: 'The seat indexes to unlock.' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(VIDEO_ROOM_MAX_SEATS)
  @IsInt({ each: true })
  @Min(0, { each: true })
  seatIndexes!: number[];
}

/** Move the caller's own occupancy to another seat. */
export class SwitchSeatDto {
  @ApiProperty({ minimum: 0, description: 'The destination seat.' })
  @IsInt()
  @Min(0)
  toSeatIndex!: number;
}

/** Move another user between seats (owner/admin). `force` evicts the destination occupant. */
export class TransferSeatDto {
  @ApiProperty({ description: 'The user being moved.' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ minimum: 0, description: 'The destination seat.' })
  @IsInt()
  @Min(0)
  toSeatIndex!: number;

  @ApiPropertyOptional({
    minimum: 0,
    description: "The user's current seat (inferred if omitted).",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  fromSeatIndex?: number;

  @ApiPropertyOptional({ default: false, description: 'Evict the destination occupant first.' })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/** Remove a speaker from a seat (owner/admin). Speaker returns to audience. */
export class RemoveSpeakerFromSeatDto {
  @ApiProperty({ description: 'The speaker user ID to remove from seat.' })
  @IsUUID()
  speakerId!: string;

  @ApiPropertyOptional({ minimum: 0, description: 'The seat index occupied by the speaker.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  seatIndex?: number;

  @ApiPropertyOptional({ description: 'The current active broadcast session ID.' })
  @IsOptional()
  @IsUUID()
  sessionId?: string;
}
