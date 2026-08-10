import { ApiPropertyOptional } from '@nestjs/swagger';
import { Gender } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Length, MaxLength } from 'class-validator';

const cleanEmptyString = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** Editable profile fields. Writes span `users` (identity display) + `user_profiles`. */
export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'aditya_123' })
  @IsOptional()
  @Transform(cleanEmptyString)
  @IsString()
  @Length(4, 20)
  username?: string;

  @ApiPropertyOptional({ example: 'Aditya Reddy' })
  @IsOptional()
  @Transform(cleanEmptyString)
  @IsString()
  @Length(1, 100)
  fullName?: string;

  @ApiPropertyOptional({ example: 'Music, gaming, live streams ✨', maxLength: 300 })
  @IsOptional()
  @Transform(cleanEmptyString)
  @IsString()
  @MaxLength(300)
  bio?: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiPropertyOptional({ example: 'IN' })
  @IsOptional()
  @Transform(cleanEmptyString)
  @IsString()
  @Length(2, 64)
  country?: string;

  @ApiPropertyOptional({ example: 'Telangana' })
  @IsOptional()
  @Transform(cleanEmptyString)
  @IsString()
  @MaxLength(80)
  state?: string;

  @ApiPropertyOptional({ example: 'Hyderabad' })
  @IsOptional()
  @Transform(cleanEmptyString)
  @IsString()
  @MaxLength(80)
  city?: string;

  @ApiPropertyOptional({ example: '1990-01-01' })
  @IsOptional()
  @Transform(cleanEmptyString)
  @IsString()
  dateOfBirth?: string;

  @ApiPropertyOptional({ example: 'en' })
  @IsOptional()
  @Transform(cleanEmptyString)
  @IsString()
  @Length(2, 16)
  preferredLanguage?: string;
}
