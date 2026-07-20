import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { AudioOutput, CameraFacing, MediaStreamKind, VideoQualityProfile } from '../enums';

/** Join the media (RTC) session for a room (VR-5). All fields are client-reported context. */
export class JoinMediaDto {
  @ApiPropertyOptional({ description: 'Registered device UUID.' })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional({ description: 'Client platform, e.g. IOS / ANDROID / WEB.' })
  @IsOptional()
  @IsString()
  platform?: string;

  @ApiPropertyOptional({ description: 'Client-reported network type, e.g. WIFI / CELLULAR.' })
  @IsOptional()
  @IsString()
  network?: string;
}

/** Start publishing a media stream (VR-5). Defaults to the camera stream. */
export class PublishStreamDto {
  @ApiPropertyOptional({ enum: MediaStreamKind, default: MediaStreamKind.CAMERA })
  @IsOptional()
  @IsEnum(MediaStreamKind)
  streamKind?: MediaStreamKind;
}

/** Subscribe to another participant's stream (VR-5). */
export class SubscribeStreamDto {
  @ApiProperty({ description: "The publisher's user id." })
  @IsUUID()
  targetUserId!: string;

  @ApiPropertyOptional({ minimum: 0, description: 'Subscription priority (higher first).' })
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;
}

/** Unsubscribe from another participant's stream (VR-5). */
export class UnsubscribeStreamDto {
  @ApiProperty({ description: "The publisher's user id." })
  @IsUUID()
  targetUserId!: string;
}

/** Switch the caller's publishing camera between front/rear (VR-5). */
export class CameraSwitchDto {
  @ApiProperty({ enum: CameraFacing })
  @IsEnum(CameraFacing)
  facing!: CameraFacing;
}

/** Force-mute (or unmute) another participant's stream (owner/admin, VR-5). */
export class ForceMuteDto {
  @ApiProperty({ description: 'The target participant.' })
  @IsUUID()
  targetUserId!: string;

  @ApiProperty({ description: 'True to mute, false to unmute.' })
  @IsBoolean()
  muted!: boolean;
}

/** Report/change the caller's active audio output route (VR-5). */
export class AudioOutputDto {
  @ApiProperty({ enum: AudioOutput })
  @IsEnum(AudioOutput)
  output!: AudioOutput;
}

/** Set the caller's publishing video quality profile (VR-5). */
export class SetQualityDto {
  @ApiProperty({ enum: VideoQualityProfile })
  @IsEnum(VideoQualityProfile)
  profile!: VideoQualityProfile;
}

/** Beauty-filter settings for the caller's publishing camera stream (VR-5). */
export class BeautySettingsDto {
  @ApiProperty({ description: 'Master on/off switch for beauty effects.' })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: 100, description: 'Overall beauty level 0–100.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  level?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100, description: 'Skin-smoothing strength 0–100.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  smoothSkin?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100, description: 'Brightness adjustment 0–100.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  brightness?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100, description: 'Sharpen strength 0–100.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  sharpen?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100, description: 'Face-enhance strength 0–100.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  faceEnhance?: number;
}

/** Periodic client-reported media-quality heartbeat (VR-5). All fields optional/best-effort. */
export class MediaHeartbeatDto {
  @ApiPropertyOptional({ description: 'Round-trip time in milliseconds.' })
  @IsOptional()
  @IsNumber()
  rttMs?: number;

  @ApiPropertyOptional({ description: 'Packet loss percentage (0–100).' })
  @IsOptional()
  @IsNumber()
  packetLossPct?: number;

  @ApiPropertyOptional({ description: 'Observed frame rate (fps).' })
  @IsOptional()
  @IsNumber()
  frameRate?: number;

  @ApiPropertyOptional({ description: 'Observed bitrate in kbps.' })
  @IsOptional()
  @IsNumber()
  bitrateKbps?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 5,
    description: 'Client-perceived quality 0 (worst) – 5 (best).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  qualityLevel?: number;
}

/** Recover the caller's media session after a reconnect (VR-5). */
export class RecoverMediaDto {
  @ApiPropertyOptional({ minimum: 0, description: 'Last stage version the client observed.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  lastVersion?: number;
}
