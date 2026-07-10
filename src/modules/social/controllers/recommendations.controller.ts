import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RecommendationsDto } from '../dto/recommendations.dto';
import { RecommendationsService } from '../services/recommendations.service';

/** Backend-driven user recommendations (mutual / popular / trending / all). */
@ApiTags('social')
@ApiBearerAuth()
@Controller('social/recommendations')
export class RecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  @Get()
  @ApiOperation({ summary: 'Suggested users to follow/friend' })
  list(@CurrentUser('id') userId: string, @Query() q: RecommendationsDto) {
    return this.recommendations.recommend(userId, q.kind, q.page, q.limit);
  }
}
