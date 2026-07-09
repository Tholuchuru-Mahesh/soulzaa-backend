import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VerificationType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/** Submit an account-verification (blue-check) request. */
export class VerificationRequestDto {
  @ApiProperty({ enum: VerificationType })
  @IsEnum(VerificationType)
  type!: VerificationType;

  @ApiPropertyOptional({ description: 'S3 key of an uploaded supporting document' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  documentKey?: string;
}

/** Admin decision on a verification request. */
export class ReviewVerificationDto {
  @ApiPropertyOptional({ description: 'Reason (required when rejecting)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
