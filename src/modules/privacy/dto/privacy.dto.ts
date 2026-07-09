import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PrivacyLevel } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PrivacyAction } from '../interfaces/privacy.interface';

/** Update any subset of the privacy visibility/permission levels. */
export class UpdatePrivacySettingsDto {
  @ApiPropertyOptional({ enum: PrivacyLevel })
  @IsOptional()
  @IsEnum(PrivacyLevel)
  onlineStatus?: PrivacyLevel;

  @ApiPropertyOptional({ enum: PrivacyLevel })
  @IsOptional()
  @IsEnum(PrivacyLevel)
  lastSeen?: PrivacyLevel;

  @ApiPropertyOptional({ enum: PrivacyLevel })
  @IsOptional()
  @IsEnum(PrivacyLevel)
  profileVisibility?: PrivacyLevel;

  @ApiPropertyOptional({ enum: PrivacyLevel })
  @IsOptional()
  @IsEnum(PrivacyLevel)
  callPermission?: PrivacyLevel;

  @ApiPropertyOptional({ enum: PrivacyLevel })
  @IsOptional()
  @IsEnum(PrivacyLevel)
  messagePermission?: PrivacyLevel;

  @ApiPropertyOptional({ enum: PrivacyLevel })
  @IsOptional()
  @IsEnum(PrivacyLevel)
  friendRequestPermission?: PrivacyLevel;
}

/** Update any subset of general user preferences. */
export class UpdatePreferencesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  searchable?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showActivity?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  readReceipts?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowTagging?: boolean;
}

/** Block a user by id or username. */
export class BlockUserDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  username?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

/** Unblock a user by id or username. */
export class UnblockUserDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  username?: string;
}

/** Query a privacy check for the current viewer against a target. */
export class CheckPrivacyDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  target!: string;

  @ApiProperty({ enum: PrivacyAction })
  @IsEnum(PrivacyAction)
  action!: PrivacyAction;
}
