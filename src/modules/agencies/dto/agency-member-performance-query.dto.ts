import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export class AgencyMemberPerformanceQueryDto {
  @ApiPropertyOptional({ enum: ['week', 'month', 'quarter'], default: 'month' })
  @IsOptional()
  @IsIn(['week', 'month', 'quarter'])
  range?: 'week' | 'month' | 'quarter';
}
