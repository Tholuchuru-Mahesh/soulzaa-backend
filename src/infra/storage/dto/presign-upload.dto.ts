import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, IsMimeType, IsPositive, IsString, MaxLength } from 'class-validator';
import { MediaCategory, STORAGE_CATEGORIES } from '../storage.constants';

const CATEGORY_VALUES = Object.values(STORAGE_CATEGORIES);

export class PresignUploadDto {
  @ApiProperty({ enum: CATEGORY_VALUES, example: STORAGE_CATEGORIES.PROFILE_IMAGE })
  @IsEnum(STORAGE_CATEGORIES)
  category!: MediaCategory;

  @ApiProperty({ example: 'avatar.png' })
  @IsString()
  @MaxLength(255)
  filename!: string;

  @ApiProperty({ example: 'image/png' })
  @IsMimeType()
  contentType!: string;

  @ApiProperty({ example: 204800, description: 'Declared file size in bytes' })
  @IsInt()
  @IsPositive()
  size!: number;
}
