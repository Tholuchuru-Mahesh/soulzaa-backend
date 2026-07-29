import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { VIDEO_ROOM_SLOW_MODE_MAX_SECONDS } from '../constants/video-room.constants';

/**
 * Patch a room's configurable settings. Every field is optional (a partial
 * update), per-field permission gated by VideoRoomSettingsService.
 *
 * THIS CLASS MUST STAY EQUAL TO `WRITABLE_SETTINGS_FIELDS` — pinned by
 * update-video-room-settings.dto.spec.ts. It is deliberately NOT a mirror of
 * the VideoRoomSettings table: a field belongs here only once it has an
 * enforcing guard, so the API never advertises a setting that does nothing.
 *
 * NOT HERE, on purpose:
 *  - `hostSeatCount` / `guestSeatCount` — real, but edited through
 *    `POST /video-rooms/:id/seats/layout` (video-rooms-seats.controller.ts).
 *  - `isRoomMuted` — runtime state written only by mute-all/unmute-all.
 *  - `allowViewerChat` — internal mirror of `chatMode`, never client-writable.
 *  - `allowScreenShare` / `allowRecording` — no implementation exists.
 *  - `joinApprovalRequired`, `allowJoinRequest`, `allowShare`, `allowFollow`,
 *    `maxDurationMinutes` — unenforced; they return with their guards in
 *    sub-projects B and C.
 */
export class UpdateVideoRoomSettingsDto {
  // ---- Chat ----
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowChat?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: VIDEO_ROOM_SLOW_MODE_MAX_SECONDS })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(VIDEO_ROOM_SLOW_MODE_MAX_SECONDS)
  slowModeSeconds?: number;

  // ---- Economy / interactive ----
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowGifts?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowTreasure?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowPk?: boolean;

  // ---- Media policy (gates, not media transport) ----
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowBeauty?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowCameraSwitch?: boolean;

  // ---- Social ----
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowInvite?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowReporting?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowAnnouncements?: boolean;

  /**
   * VR-8 column, VR-17 wire-up: when true a freed seat waits for owner/admin
   * approval; when false the front of the seat queue is auto-promoted.
   */
  @ApiPropertyOptional() @IsOptional() @IsBoolean() seatApprovalRequired?: boolean;
}
