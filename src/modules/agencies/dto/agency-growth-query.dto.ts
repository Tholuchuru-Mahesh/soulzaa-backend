import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import type { GrowthRange } from '../interfaces/agency-dashboard.interface';

const GROWTH_RANGES: readonly GrowthRange[] = ['week', 'month', 'quarter'];

export class AgencyGrowthQueryDto {
  @ApiPropertyOptional({
    enum: GROWTH_RANGES,
    default: 'month',
    description: 'Trailing window the chart plots: 7, 30 or 90 daily points.',
  })
  @IsOptional()
  @IsIn(GROWTH_RANGES)
  range: GrowthRange = 'month';
}
