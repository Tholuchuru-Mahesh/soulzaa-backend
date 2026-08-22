import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

/** Mirrors BanUserGloballyDto's free-text reason convention — the "selectable
 * reason" requirement is a frontend dropdown over this field, not a new
 * backend enum (the three room types each have their own report-reason
 * enum, so no single enum could type this field across all three anyway). */
export class BanBroadDto {
  @ApiProperty({ maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'URL returned by POST /storage/confirm for the BROAD_BAN_EVIDENCE category.' })
  @IsOptional()
  @IsUrl()
  proofUrl?: string;
}
