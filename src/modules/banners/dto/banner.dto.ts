import { IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, IsUrl, Max, Min, MinLength, ValidateIf } from 'class-validator';
import { BannerMediaType, BannerRedirectPage } from '@prisma/client';

export class CreateBannerDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @MinLength(1)
  imageKey!: string;

  @IsEnum(BannerMediaType)
  @IsOptional()
  mediaType?: BannerMediaType;

  /** Fraction of the media's own width, 0.0-1.0, default 0.5 (center) — see
   * HomeBanner.focalX in the schema. */
  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  focalX?: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  focalY?: number;

  @IsEnum(BannerRedirectPage)
  redirectPage!: BannerRedirectPage;

  @ValidateIf((o) => o.redirectPage === BannerRedirectPage.AUDIO_ROOM)
  @IsUUID()
  redirectTargetId?: string;

  @ValidateIf((o) => o.redirectPage === BannerRedirectPage.EXTERNAL_URL)
  @IsUrl()
  externalUrl?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsInt()
  @IsOptional()
  sortOrder?: number;
}

export class UpdateBannerDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @MinLength(1)
  @IsOptional()
  imageKey?: string;

  @IsEnum(BannerMediaType)
  @IsOptional()
  mediaType?: BannerMediaType;

  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  focalX?: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  focalY?: number;

  @IsEnum(BannerRedirectPage)
  @IsOptional()
  redirectPage?: BannerRedirectPage;

  @IsUUID()
  @IsOptional()
  redirectTargetId?: string;

  @IsUrl()
  @IsOptional()
  externalUrl?: string;

  @IsInt()
  @IsOptional()
  sortOrder?: number;
}

export class ReorderBannersDto {
  /** Ordered array of banner ids — index in the array becomes its sortOrder. */
  @IsUUID('4', { each: true })
  orderedIds!: string[];
}
