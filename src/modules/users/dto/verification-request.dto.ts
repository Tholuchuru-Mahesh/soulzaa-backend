import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VerificationType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/** Submit an account-verification (blue-check) request. */
export class VerificationRequestDto {
  @ApiProperty({ enum: VerificationType })
  @IsEnum(VerificationType)
  type!: VerificationType;

  @ApiPropertyOptional({
    description:
      'Creator Category/Type: Gamer, Singer, Magician, Comedian, Audio, Video, Influencer, Artist',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({ description: 'S3 key of an uploaded supporting document or JSON payload' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
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
