import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsInt,
  IsDateString,
  IsObject,
  IsArray,
  IsBoolean,
  Min,
} from 'class-validator';

// ── Send Notification ─────────────────────────────────────────────────
export class SendNotificationDto {
  @ApiPropertyOptional({ description: 'UUID of the recipient user (null for broadcast)' })
  @IsUUID()
  @IsOptional()
  recipientId?: string;

  @ApiProperty({ example: 'WALLET', description: 'Notification category type' })
  @IsString()
  @IsNotEmpty()
  type!: string;

  @ApiProperty({ example: 'WALLET_DEPOSIT', description: 'Template key code' })
  @IsString()
  @IsNotEmpty()
  templateCode!: string;

  @ApiProperty({ description: 'JSON dictionary of variables to inject', type: Object })
  @IsObject()
  variables!: Record<string, string>;

  @ApiPropertyOptional({ enum: ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] })
  @IsString()
  @IsOptional()
  priority?: string;

  @ApiPropertyOptional({ description: 'ISO8601 schedule date' })
  @IsDateString()
  @IsOptional()
  scheduledAt?: string;

  @ApiPropertyOptional({ type: [String], example: ['IN_APP', 'PUSH'] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  channels?: string[];
}

// ── Create Notification Template ──────────────────────────────────────
export class CreateTemplateDto {
  @ApiProperty({ example: 'WELCOME_USER' })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiProperty({ example: 'Welcome, {username}!' })
  @IsString()
  @IsNotEmpty()
  titleTemplate!: string;

  @ApiProperty({ example: 'We are thrilled to have you here at Soulzaa, {username}.' })
  @IsString()
  @IsNotEmpty()
  bodyTemplate!: string;

  @ApiPropertyOptional({ example: 'en' })
  @IsString()
  @IsOptional()
  locale?: string;

  @ApiPropertyOptional({ type: [String], example: ['username'] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  variables?: string[];
}

// ── Update Notification Preference ────────────────────────────────────
export class UpdatePreferenceDto {
  @ApiProperty({ description: 'UUID of the setting owner user' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ example: 'GIFT' })
  @IsString()
  @IsNotEmpty()
  type!: string;

  @ApiProperty({ example: 'EMAIL' })
  @IsString()
  @IsNotEmpty()
  channel!: string;

  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;
}

// ── Dynamic Configuration Update ──────────────────────────────────────
export class UpdateConfigDto {
  @ApiProperty({ example: 'notification.retry_count' })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiProperty({ description: 'Configuration value (JSON)', type: Object })
  value!: unknown;
}
