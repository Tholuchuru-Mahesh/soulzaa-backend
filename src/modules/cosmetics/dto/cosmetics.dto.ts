import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CosmeticRarity, CosmeticType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

/** Admin: create a catalog cosmetic. */
export class CosmeticDto {
  @ApiProperty({ enum: CosmeticType })
  @IsEnum(CosmeticType)
  type!: CosmeticType;

  @ApiProperty({ maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  mediaUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  thumbnailUrl?: string;

  @ApiProperty({ enum: CosmeticRarity })
  @IsEnum(CosmeticRarity)
  rarity!: CosmeticRarity;

  @ApiPropertyOptional({ minimum: 0, default: 0, description: 'Gold price (premium store).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  price?: number;

  @ApiPropertyOptional({ default: false, description: 'Purchasable in the premium store.' })
  @IsOptional()
  @IsBoolean()
  isPremium?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  transferable?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'TTL or duration in days (0 or null = permanent).' })
  @IsOptional()
  @Type(() => Number)
  durationDays?: number;

  @ApiPropertyOptional({ description: 'Additional metadata such as TTL configuration.' })
  @IsOptional()
  metadata?: Record<string, any>;
}

/** Admin: partial update of a cosmetic. */
export class UpdateCosmeticDto {
  @ApiPropertyOptional({ enum: CosmeticType })
  @IsOptional()
  @IsEnum(CosmeticType)
  type?: CosmeticType;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  mediaUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  thumbnailUrl?: string;

  @ApiPropertyOptional({ enum: CosmeticRarity })
  @IsOptional()
  @IsEnum(CosmeticRarity)
  rarity?: CosmeticRarity;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  price?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPremium?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  transferable?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'TTL or duration in days (0 or null = permanent).' })
  @IsOptional()
  @Type(() => Number)
  durationDays?: number;

  @ApiPropertyOptional({ description: 'Additional metadata such as TTL configuration.' })
  @IsOptional()
  metadata?: Record<string, any>;
}

/** Catalog listing filter. */
export class ListCosmeticsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: CosmeticType })
  @IsOptional()
  @IsEnum(CosmeticType)
  type?: CosmeticType;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  enabled?: boolean;
}
