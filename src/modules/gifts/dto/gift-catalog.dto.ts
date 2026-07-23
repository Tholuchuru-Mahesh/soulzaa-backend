import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GiftCategory, GiftType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateGiftCategoryDto {
  @ApiProperty({ description: 'Category unique code (e.g. CLASSIC, LUXURY, VIP)' })
  @IsNotEmpty()
  @IsString()
  code!: string;

  @ApiProperty({ description: 'Category name' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiPropertyOptional({ description: 'Category description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Category icon URL' })
  @IsString()
  @IsOptional()
  iconUrl?: string;

  @ApiPropertyOptional({ description: 'Sort display order', default: 0 })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  sortOrder?: number = 0;
}

export class CreateGiftDto {
  @ApiProperty({ description: 'Gift unique code (e.g. ROSE_GIFT_001)' })
  @IsNotEmpty()
  @IsString()
  code!: string;

  @ApiProperty({ description: 'Internal gift name' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiPropertyOptional({ description: 'User-facing display name' })
  @IsString()
  @IsOptional()
  displayName?: string;

  @ApiPropertyOptional({ description: 'Gift description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ enum: GiftCategory, description: 'Gift Category', default: GiftCategory.CLASSIC })
  @IsEnum(GiftCategory)
  @IsNotEmpty()
  category!: GiftCategory;

  @ApiProperty({ enum: GiftType, description: 'Gift Presentation Type', default: GiftType.STATIC })
  @IsEnum(GiftType)
  @IsNotEmpty()
  type!: GiftType;

  @ApiProperty({ description: 'Price in Soul Gold Coins', example: 10 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsNotEmpty()
  coinValue!: number;

  @ApiPropertyOptional({ description: 'Thumbnail URL' })
  @IsString()
  @IsOptional()
  thumbnailUrl?: string;

  @ApiPropertyOptional({ description: 'Animation URL' })
  @IsString()
  @IsOptional()
  animationUrl?: string;

  @ApiPropertyOptional({ description: 'Lottie Animation URL' })
  @IsString()
  @IsOptional()
  lottieUrl?: string;

  @ApiPropertyOptional({ description: 'SVGA Animation URL' })
  @IsString()
  @IsOptional()
  svgaUrl?: string;

  @ApiPropertyOptional({ description: 'MP4 Video URL' })
  @IsString()
  @IsOptional()
  mp4Url?: string;

  @ApiPropertyOptional({ description: 'Sound Effect URL' })
  @IsString()
  @IsOptional()
  soundUrl?: string;

  @ApiPropertyOptional({ description: 'Display priority ranking', default: 0 })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  priority?: number = 0;

  @ApiPropertyOptional({ description: 'Tags array (e.g. ["popular", "love"])' })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ description: 'Minimum required VIP level', default: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  minVipLevel?: number = 0;

  @ApiPropertyOptional({ description: 'Combo streak enabled toggle', default: false })
  @IsBoolean()
  @IsOptional()
  comboEnabled?: boolean = false;

  @ApiPropertyOptional({ description: 'Active enabled toggle', default: true })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean = true;
}

export class UpdateGiftDto {
  @ApiPropertyOptional({ description: 'User-facing display name' })
  @IsString()
  @IsOptional()
  displayName?: string;

  @ApiPropertyOptional({ description: 'Price in Soul Gold Coins' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  coinValue?: number;

  @ApiPropertyOptional({ description: 'Thumbnail URL' })
  @IsString()
  @IsOptional()
  thumbnailUrl?: string;

  @ApiPropertyOptional({ description: 'Animation URL' })
  @IsString()
  @IsOptional()
  animationUrl?: string;

  @ApiPropertyOptional({ description: 'Lottie Animation URL' })
  @IsString()
  @IsOptional()
  lottieUrl?: string;

  @ApiPropertyOptional({ description: 'SVGA Animation URL' })
  @IsString()
  @IsOptional()
  svgaUrl?: string;

  @ApiPropertyOptional({ description: 'MP4 Video URL' })
  @IsString()
  @IsOptional()
  mp4Url?: string;

  @ApiPropertyOptional({ description: 'Active enabled toggle' })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}

export class GiftQueryDto {
  @ApiPropertyOptional({ description: 'Filter by category (CLASSIC, LUXURY, VIP, etc.)' })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiPropertyOptional({ description: 'Filter by type (STATIC, ANIMATED, COMBO, etc.)' })
  @IsString()
  @IsOptional()
  type?: string;

  @ApiPropertyOptional({ description: 'Filter enabled status (true/false)' })
  @Type(() => Boolean)
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}
