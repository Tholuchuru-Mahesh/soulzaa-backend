import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class SettingSearchFilterDto {
  @ApiPropertyOptional({ description: 'Search term for setting key or description' })
  @IsString()
  @IsOptional()
  query?: string;

  @ApiPropertyOptional({
    description:
      'Filter by category (GENERAL, AUTH, SECURITY, FEATURE_FLAGS, AUDIO_ROOM, VIDEO_ROOM, GAME, GIFT, COIN, WALLET, VIP, EVENT, NOTIFICATION, AGORA, S3, RATE_LIMITING, MAINTENANCE)',
  })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiPropertyOptional({ description: 'Filter only feature flags (true/false)' })
  @Type(() => Boolean)
  @IsBoolean()
  @IsOptional()
  isFeatureFlag?: boolean;

  @ApiPropertyOptional({ description: 'Page number (default 1)', default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Page limit (default 50, max 200)', default: 50 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit?: number = 50;

  @ApiPropertyOptional({
    description: 'Field to sort by (key, category, updatedAt)',
    default: 'category',
  })
  @IsString()
  @IsOptional()
  sortBy?: string = 'category';

  @ApiPropertyOptional({ description: 'Sort direction (asc or desc)', default: 'asc' })
  @IsString()
  @IsOptional()
  sortOrder?: 'asc' | 'desc' = 'asc';
}
