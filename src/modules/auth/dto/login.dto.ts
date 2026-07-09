import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsOptional, IsString, ValidateNested } from 'class-validator';
import { DeviceInfoDto } from './device-info.dto';

/** Email + password login. */
export class LoginDto {
  @ApiProperty({ example: 'aditya@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Str0ng@Pass' })
  @IsString()
  password!: string;

  @ApiPropertyOptional({ type: DeviceInfoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceInfoDto)
  device?: DeviceInfoDto;
}
