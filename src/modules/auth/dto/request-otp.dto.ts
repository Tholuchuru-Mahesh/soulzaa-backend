import { ApiProperty } from '@nestjs/swagger';
import { OtpPurpose } from '@prisma/client';
import { IsEnum, IsString, MaxLength } from 'class-validator';

/**
 * Request an OTP for a destination (mobile number or email) and purpose. The
 * channel (SMS/email) is inferred from the purpose/destination server-side.
 */
export class RequestOtpDto {
  @ApiProperty({ example: '+919876543210', description: 'Mobile number or email' })
  @IsString()
  @MaxLength(256)
  destination!: string;

  @ApiProperty({ enum: OtpPurpose })
  @IsEnum(OtpPurpose)
  purpose!: OtpPurpose;
}
