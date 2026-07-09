import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_AUDIO_SEATS } from 'src/common/constants/room.constants';

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
}
