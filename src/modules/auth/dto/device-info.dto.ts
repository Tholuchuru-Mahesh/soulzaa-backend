import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DevicePlatform } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/** Optional device fingerprint clients send on login/register (→ user_devices). */
export class DeviceInfoDto {
  @ApiProperty({ description: 'Stable per-device identifier from the client' })
  @IsString()
  @MaxLength(256)
  deviceIdentifier!: string;

  @ApiProperty({ enum: DevicePlatform })
  @IsEnum(DevicePlatform)
  platform!: DevicePlatform;

  @ApiPropertyOptional({ description: 'Push notification token' })
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
