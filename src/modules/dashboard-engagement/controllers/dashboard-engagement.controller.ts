import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { DashboardEngagementService } from '../services/dashboard-engagement.service';

/**
 * Engagement web dashboards for the admin console: gifts, treasure boxes,
 * families, VIP, level & achievements, rankings and referrals.
 *
 * Gated on `dashboard.engagement.view` — ADMIN only, SUPER_ADMIN via wildcard.
 */
@ApiTags('Dashboard — Engagement')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@RequirePermissions('dashboard.engagement.view')
@Controller('dashboard/engagement')
export class DashboardEngagementController {
  constructor(private readonly service: DashboardEngagementService) {}

  @ApiOperation({ summary: 'Gift analytics — volume, value and top gifts' })
  @ApiQuery({ name: 'top', required: false, description: 'Leaderboard size (default 10)' })
  @ApiResponse({ status: 200, description: 'Gift catalogue and send volume' })
  @Get('gifts')
  gifts(@Query('top') top?: string) {
    return this.service.giftDashboard(Number(top) || 10);
  }

  @ApiOperation({ summary: 'Treasure box monitoring — sessions, boxes and rewards' })
  @ApiResponse({ status: 200, description: 'Treasure engine activity' })
  @Get('treasure')
  treasure() {
    return this.service.treasureDashboard();
  }

  @ApiOperation({ summary: 'Family management — population and largest families' })
  @ApiQuery({ name: 'top', required: false, description: 'Leaderboard size (default 10)' })
  @ApiResponse({ status: 200, description: 'Family counts and size distribution' })
  @Get('families')
  families(@Query('top') top?: string) {
    return this.service.familyDashboard(Number(top) || 10);
  }

  @ApiOperation({ summary: 'VIP management — membership mix by tier' })
  @ApiResponse({ status: 200, description: 'VIP membership and subscription counts' })
  @Get('vip')
  vip() {
    return this.service.vipDashboard();
  }

  @ApiOperation({ summary: 'Level & achievement monitoring — progression and unlocks' })
  @ApiQuery({ name: 'top', required: false, description: 'Leaderboard size (default 10)' })
  @ApiResponse({ status: 200, description: 'Level spread and achievement volume' })
  @Get('progression')
  progression(@Query('top') top?: string) {
    return this.service.progressionDashboard(Number(top) || 10);
  }

  @ApiOperation({ summary: 'Ranking dashboard — leaderboards and snapshot coverage' })
  @ApiResponse({ status: 200, description: 'Ranking definitions, entries and snapshots' })
  @Get('rankings')
  rankings() {
    return this.service.rankingDashboard();
  }

  @ApiOperation({ summary: 'Referral management — funnel and top referrers' })
  @ApiQuery({ name: 'top', required: false, description: 'Leaderboard size (default 10)' })
  @ApiResponse({ status: 200, description: 'Referral funnel by status' })
  @Get('referrals')
  referrals(@Query('top') top?: string) {
    return this.service.referralDashboard(Number(top) || 10);
  }
}
