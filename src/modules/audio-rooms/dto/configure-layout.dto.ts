import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min, IsObject } from 'class-validator';
import { MAX_AUDIO_SEATS } from 'src/common/constants/room.constants';

/**
 * Optional seat settings metadata persisted alongside the seat count config.
 * This is a free-form JSON blob so we do not add deep validators — the service
 * is the guard.  Fields:
 *   preset      – named preset slug (e.g. 'stage', 'circle', 'debate', 'classroom')
 *   seatOrder   – ordered seat index array reflecting drag-and-drop arrangement
 *   disabledSeats – seat indices the owner has toggled OFF (will be locked in DB)
 */
export class SeatLayoutMetadataDto {
  preset?: string;
  seatOrder?: number[];
  disabledSeats?: number[];
}

/**
 * Reconfigure a room's stage layout. Owner seat (seat 0) is always present and
 * not counted here. Total seats (1 + speaker + premium) is capped by
 * MAX_AUDIO_SEATS; the service re-validates and vacates any removed occupied
 * seats back to the audience.
 */
export class ConfigureLayoutDto {
  @ApiPropertyOptional({ minimum: 0, maximum: MAX_AUDIO_SEATS - 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_AUDIO_SEATS - 1)
  speakerSeatCount?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: MAX_AUDIO_SEATS - 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_AUDIO_SEATS - 1)
  premiumAdminSeatCount?: number;

  @ApiPropertyOptional({
    description: 'Require owner/admin approval before a listener takes a seat.',
  })
  @IsOptional()
  @IsBoolean()
  requireApprovalForSeat?: boolean;

  @ApiPropertyOptional({
    description: 'Optional visual metadata: preset slug, seat order, disabled seat indices.',
  })
  @IsOptional()
  @IsObject()
  metadata?: SeatLayoutMetadataDto;
}
