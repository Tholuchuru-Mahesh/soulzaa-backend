import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsISO8601, IsOptional, IsString, Matches, MinLength } from 'class-validator';

/**
 * Payload for provisioning an Admin. Mirrors the register command the auth
 * module already validates, with a longer password floor: these accounts hold
 * platform-wide authority, so the ordinary user minimum is not enough.
 */
export class CreateAdminDto {
  @ApiProperty({ example: 'Operations Lead' })
  @IsString()
  fullName!: string;

  @ApiProperty({ example: 'ops1', description: '4–20 chars, letters/digits/underscore' })
  @Matches(/^[a-zA-Z0-9_]{4,20}$/, {
    message: 'username must be 4-20 characters of letters, digits or underscore',
  })
  username!: string;

  @ApiProperty({ example: '+15551234567' })
  @IsString()
  mobile!: string;

  @ApiPropertyOptional({ example: 'ops1@soulzaa.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ minLength: 12, description: 'Minimum 12 characters for staff accounts' })
  @IsString()
  @MinLength(12)
  password!: string;

  @ApiProperty({ example: '1995-04-12', description: 'ISO date' })
  @IsISO8601()
  dateOfBirth!: string;

  @ApiProperty({ example: 'IN' })
  @IsString()
  country!: string;
}
