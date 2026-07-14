import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsOptional, ValidateIf } from 'class-validator';

/**
 * Patch the caller's notification preferences. Every field is optional and an
 * omitted field is left alone — so a client that only knows about the switches it
 * renders cannot wipe out one it has never heard of.
 */
export class UpdateNotificationPreferencesDto {
  @ApiPropertyOptional({
    description: 'Master switch. Off suppresses every category but security alerts.',
  })
  @IsOptional()
  @IsBoolean()
  pushEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Direct messages and chat requests.' })
  @IsOptional()
  @IsBoolean()
  messageEvents?: boolean;

  @ApiPropertyOptional({ description: 'Incoming and missed calls.' })
  @IsOptional()
  @IsBoolean()
  callEvents?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  friendEvents?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  followEvents?: boolean;

  @ApiPropertyOptional({ description: 'Room / game / family / PK / event invitations.' })
  @IsOptional()
  @IsBoolean()
  inviteEvents?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  giftEvents?: boolean;

  @ApiPropertyOptional({ description: 'Announcements and everything else.' })
  @IsOptional()
  @IsBoolean()
  systemEvents?: boolean;

  @ApiPropertyOptional({ description: 'Selects the audible vs silent Android channel.' })
  @IsOptional()
  @IsBoolean()
  sound?: boolean;

  @ApiPropertyOptional({ description: 'Selects the vibrating vs still Android channel.' })
  @IsOptional()
  @IsBoolean()
  vibration?: boolean;

  @ApiPropertyOptional({
    description:
      'Off replaces the push body with a generic string *on the server*, so the content never reaches the device.',
  })
  @IsOptional()
  @IsBoolean()
  showPreview?: boolean;

  @ApiPropertyOptional({
    description: 'Mute everything until this instant. Send null to cancel the snooze.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @IsOptional()
  // `null` is a meaningful value here (cancel the snooze), so it has to survive
  // validation rather than be rejected as "not a date".
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  @Transform(({ value }) => (value === null ? null : value))
  mutedUntil?: string | null;
}
