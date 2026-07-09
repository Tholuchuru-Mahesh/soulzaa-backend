import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Gender } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsISO8601,
  IsMobilePhone,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { DeviceInfoDto } from './device-info.dto';
import { IsMinimumAge } from './validators/is-minimum-age.validator';
import { IsStrongPassword } from './validators/is-strong-password.validator';

/** New-account registration (mobile is required; OTP verifies it post-register). */
export class RegisterDto {
  @ApiProperty({ example: 'Aditya Reddy' })
  @IsString()
  @Length(1, 100)
  fullName!: string;

  @ApiProperty({ example: 'aditya_r', minLength: 4, maxLength: 20 })
  @IsString()
  @Length(4, 20)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'Username may contain only letters, numbers and underscores',
  })
  username!: string;

  @ApiProperty({ example: '+919876543210' })
  @IsMobilePhone()
  mobile!: string;

  @ApiPropertyOptional({ example: 'aditya@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ example: 'Str0ng@Pass', description: 'Min 8, upper, lower, number, special' })
  @IsStrongPassword()
  password!: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiProperty({ example: '2000-05-14', description: 'ISO date; must be 18+' })
  @IsISO8601()
  @IsMinimumAge(18)
  dateOfBirth!: string;

  @ApiProperty({ example: 'IN' })
  @IsString()
  @Length(2, 64)
  country!: string;

  @ApiPropertyOptional({ example: 'en' })
  @IsOptional()
  @IsString()
  @Length(2, 16)
  preferredLanguage?: string;

  @ApiPropertyOptional({ type: DeviceInfoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceInfoDto)
  device?: DeviceInfoDto;
}
