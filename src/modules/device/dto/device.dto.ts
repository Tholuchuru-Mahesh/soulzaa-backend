import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DevicePlatform } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/** Explicit device registration / push-token association from the client. */
export class RegisterDeviceDto {
  @ApiProperty({ description: 'Stable per-device identifier from the client' })
  @IsString()
  @MaxLength(256)
  deviceIdentifier!: string;

  @ApiProperty({ enum: DevicePlatform })
  @IsEnum(DevicePlatform)
  platform!: DevicePlatform;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  pushToken?: string;

  @ApiPropertyOptional({ example: "Aditya's iPhone" })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  deviceName?: string;

  @ApiPropertyOptional({ example: 'iPhone 15 Pro' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  deviceType?: string;

  @ApiPropertyOptional({ example: '17.4' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  osVersion?: string;

  @ApiPropertyOptional({ example: '1.2.0' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  appVersion?: string;

  @ApiPropertyOptional({ example: 'IN' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  country?: string;
}

/** Rename a device. */
export class RenameDeviceDto {
  @ApiProperty({ example: "Aditya's iPad" })
  @IsString()
  @MaxLength(80)
  deviceName!: string;
}

/** Update (or clear) the push token for a device. */
export class UpdatePushTokenDto {
  @ApiProperty({ description: 'The device id to update' })
  @IsString()
  @MaxLength(64)
  deviceId!: string;

  @ApiPropertyOptional({ description: 'New push token; omit/empty to clear' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  pushToken?: string;

  @ApiPropertyOptional({
    description:
      "Which token this is. 'voip' is the PushKit token iOS issues for a " +
      "backgrounded/killed-app incoming-call ring (see ApnsVoipPushProvider); " +
      "omit for the ordinary push token every other notification uses.",
    enum: ['fcm', 'voip'],
    default: 'fcm',
  })
  @IsOptional()
  @IsEnum(['fcm', 'voip'])
  tokenType?: 'fcm' | 'voip';
}
