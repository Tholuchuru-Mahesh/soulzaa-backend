import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class AgencyAuditLogQueryDto {
  @ApiPropertyOptional({
    description: 'Filter to one audited resource, e.g. `coin_seller_inventory`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  module?: string;

  @ApiPropertyOptional({ description: 'Narrows by action name.' })
  @IsOptional()
  @IsString()
  // Bounded so a huge string cannot be pushed into a LIKE scan.
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
