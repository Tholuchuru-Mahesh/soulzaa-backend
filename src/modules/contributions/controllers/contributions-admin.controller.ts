import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from 'src/common/decorators/roles.decorator';
import {
  ContributionHistoryQueryDto,
  ContributionLeaderboardQueryDto,
  WeeklyContributionQueryDto,
} from '../dto/contributions.dto';
import { WeeklyContributionRolloverScheduler } from '../services/weekly-contribution-rollover.scheduler';
import { WeeklyContributionService } from '../services/weekly-contribution.service';

/**
 * Super Admin "Contributions" section (base `admin/contributions`). Room/user
 * contribution by ISO week: current week, last week, week/month history, and
 * per-week leaderboards. Lifetime totals stay on the legacy counters and are not
 * removed. Restricted to ADMIN / SUPER_ADMIN.
 */
@ApiTags('contributions-admin')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/contributions')
export class ContributionsAdminController {
  constructor(
    private readonly contributions: WeeklyContributionService,
    private readonly rollover: WeeklyContributionRolloverScheduler,
  ) {}

  @Get('weekly')
  @ApiOperation({ summary: 'A room/user contribution for one ISO week (+ previous week)' })
  weekly(@Query() q: WeeklyContributionQueryDto) {
    return this.contributions.weekly(q);
  }

  @Get('history')
  @ApiOperation({ summary: 'Week-wise or month-wise contribution history (paginated)' })
  history(@Query() q: ContributionHistoryQueryDto) {
    return this.contributions.history(q);
  }

  @Get('leaderboard')
  @ApiOperation({ summary: 'Top rooms / users by contribution for one ISO week' })
  leaderboard(@Query() q: ContributionLeaderboardQueryDto) {
    return this.contributions.leaderboard(q);
  }

  @Post('rollover/broadcast')
  @ApiOperation({ summary: 'Re-push the current week figure to every live room (manual nudge)' })
  broadcast() {
    return this.rollover.run();
  }
}
