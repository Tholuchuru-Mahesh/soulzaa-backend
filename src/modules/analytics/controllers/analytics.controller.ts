import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { AnalyticsSeriesQueryDto, QueryRevenueDto } from '../dto/analytics.dto';
import {
  type AnalyticsActor,
  AnalyticsReportingService,
} from '../services/analytics-reporting.service';
import { AnalyticsService } from '../services/analytics.service';

@ApiTags('analytics')
@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly reporting: AnalyticsReportingService,
  ) {}

  private actor(user: AuthenticatedUser): AnalyticsActor {
    return { id: user.id, roles: user.roles };
  }

  // ---- Room-owner analytics (owner/room-admin/platform-admin only) ----

  @Get('rooms/:roomId/report')
  @ApiOperation({ summary: 'Full room analytics report (owner/admin): today + history + revenue' })
  async report(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roomId', ParseUuidPipe) roomId: string,
    @Query() q: AnalyticsSeriesQueryDto,
  ) {
    return this.reporting.getRoomReport(this.actor(user), roomId, q.days);
  }

  @Get('rooms/:roomId/activity')
  @ApiOperation({ summary: 'Get aggregated room-level activity statistics' })
  async activity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roomId', ParseUuidPipe) roomId: string,
  ) {
    await this.reporting.assertRoomManager(this.actor(user), roomId);
    return this.analytics.getRoomActivity(roomId);
  }

  @Get('rooms/:roomId/speaking')
  @ApiOperation({ summary: 'Get speaking durations of participants in the room' })
  async speaking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roomId', ParseUuidPipe) roomId: string,
    @Query() q: PaginationQueryDto,
  ) {
    await this.reporting.assertRoomManager(this.actor(user), roomId);
    return this.analytics.getSpeakingDurations(roomId, q.skip, q.limit, q.page);
  }

  @Get('rooms/:roomId/attendance')
  @ApiOperation({ summary: 'Get visitor attendance history of the room' })
  async attendance(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roomId', ParseUuidPipe) roomId: string,
    @Query() q: PaginationQueryDto,
  ) {
    await this.reporting.assertRoomManager(this.actor(user), roomId);
    return this.analytics.getAttendance(roomId, q.skip, q.limit, q.page);
  }

  @Get('rooms/:roomId/engagement')
  @ApiOperation({ summary: 'Get engagement statistics of the room' })
  async engagement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roomId', ParseUuidPipe) roomId: string,
  ) {
    await this.reporting.assertRoomManager(this.actor(user), roomId);
    return this.analytics.getEngagement(roomId);
  }

  // ---- Creator self-analytics ----

  @Get('me')
  @NotGuest()
  @ApiOperation({ summary: "The caller's own creator analytics (today + totals + series)" })
  me(@CurrentUser() user: AuthenticatedUser, @Query() q: AnalyticsSeriesQueryDto) {
    return this.reporting.getMyAnalytics(user.id, q.days, q.roomType);
  }

  // ---- Platform revenue (admins only) ----

  @Get('revenue')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get daily aggregated revenue reports matching filters (admin)' })
  revenue(@Query() query: QueryRevenueDto) {
    return this.analytics.getRevenue(query);
  }
}
