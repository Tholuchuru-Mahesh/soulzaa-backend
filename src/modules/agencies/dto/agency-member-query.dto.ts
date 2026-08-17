import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

const MEMBER_FILTERS = ['all', 'active', 'top'] as const;

export class AgencyMemberQueryDto {
  @ApiPropertyOptional({
    description: 'Narrows the list by username, full name or country.',
  })
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

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({
    enum: MEMBER_FILTERS,
    default: 'all',
    description: '`top` is the best tenth of the agency by engagement score.',
  })
  @IsOptional()
  @IsIn(MEMBER_FILTERS)
  filter?: (typeof MEMBER_FILTERS)[number];
}
