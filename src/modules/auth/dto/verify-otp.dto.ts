import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OtpPurpose } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Length, MaxLength, ValidateNested } from 'class-validator';
import { DeviceInfoDto } from './device-info.dto';

/** Verify a previously-requested OTP. Doubles as the mobile-OTP login body. */
export class VerifyOtpDto {
  @ApiProperty({ example: '+919876543210', description: 'Mobile number or email' })
  @IsString()
  @MaxLength(256)
  destination!: string;

  @ApiProperty({ enum: OtpPurpose })
  @IsEnum(OtpPurpose)
  purpose!: OtpPurpose;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(4, 10)
  code!: string;

  @ApiPropertyOptional({ type: DeviceInfoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceInfoDto)
  device?: DeviceInfoDto;
}
