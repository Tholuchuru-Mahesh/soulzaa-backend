import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, MaxLength } from 'class-validator';
import { MediaCategory, STORAGE_CATEGORIES } from '../storage.constants';

const CATEGORY_VALUES = Object.values(STORAGE_CATEGORIES);

export class ConfirmUploadDto {
  @ApiProperty({ example: 'profile-images/u123/abc.png' })
  @IsString()
  @MaxLength(1024)
  key!: string;

  @ApiProperty({ enum: CATEGORY_VALUES, example: STORAGE_CATEGORIES.PROFILE_IMAGE })
  @IsEnum(STORAGE_CATEGORIES)
  category!: MediaCategory;
}
