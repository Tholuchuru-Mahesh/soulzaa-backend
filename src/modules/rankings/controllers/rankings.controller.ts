import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { QueryRankingsDto } from '../dto/rankings.dto';
import { RankingsService } from '../services/rankings.service';

@ApiTags('rankings')
@ApiBearerAuth()
@Controller('rankings')
export class RankingsController {
  constructor(private readonly rankings: RankingsService) {}

  @Get('gifters')
  @ApiOperation({ summary: 'Get Top Gifters leaderboard' })
  gifters(@Query() q: QueryRankingsDto) {
    return this.rankings.getGifters(q.period, q.limit, q.page);
  }

  @Get('receivers')
  @ApiOperation({ summary: 'Get Top Receivers leaderboard' })
  receivers(@Query() q: QueryRankingsDto) {
    return this.rankings.getReceivers(q.period, q.limit, q.page);
  }

  @Get('families')
  @ApiOperation({ summary: 'Get Top Families leaderboard' })
  families(@Query() q: QueryRankingsDto) {
    return this.rankings.getFamilies(q.period, q.limit, q.page);
  }

  @Get('streamers')
  @ApiOperation({ summary: 'Get Top Streamers leaderboard' })
  streamers(@Query() q: QueryRankingsDto) {
    return this.rankings.getStreamers(q.period, q.limit, q.page);
  }
}
