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

/**
 * New-account registration.
 *
 * Only an email and a password are required: the client's sign-up screen asks
 * for nothing else, and name, gender, date of birth and country are collected
 * by the profile-completion gate on first login. `username` is minted from the
 * address when omitted.
 *
 * The 18+ check still applies to any `dateOfBirth` supplied here; when it is
 * omitted the age gate is enforced at profile completion, which the client
 * cannot get past.
 */
export class RegisterDto {
  @ApiProperty({ example: 'aditya@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Str0ng@Pass', description: 'Min 8, upper, lower, number, special' })
  @IsStrongPassword()
  password!: string;

  @ApiPropertyOptional({ example: 'Aditya Reddy' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  fullName?: string;

  @ApiPropertyOptional({ example: 'aditya_r', minLength: 4, maxLength: 20 })
  @IsOptional()
  @IsString()
  @Length(4, 20)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'Username may contain only letters, numbers and underscores',
  })
  username?: string;

  @ApiPropertyOptional({ example: '+919876543210' })
  @IsOptional()
  @IsMobilePhone()
  mobile?: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiPropertyOptional({ example: '2000-05-14', description: 'ISO date; must be 18+' })
  @IsOptional()
  @IsISO8601()
  @IsMinimumAge(18)
  dateOfBirth?: string;

  @ApiPropertyOptional({ example: 'IN' })
  @IsOptional()
  @IsString()
  @Length(2, 64)
  country?: string;

  @ApiPropertyOptional({ example: 'Karnataka' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  state?: string;

  @ApiPropertyOptional({ example: 'Bengaluru' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  city?: string;

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
