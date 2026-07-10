import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { RecommendationKind } from '../services/recommendations.service';

/** Recommendations query: pick a heuristic (default merges all). */
export class RecommendationsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['mutual', 'popular', 'trending', 'all'], default: 'all' })
  @IsOptional()
  @IsIn(['mutual', 'popular', 'trending', 'all'])
  kind: RecommendationKind = 'all';
}
