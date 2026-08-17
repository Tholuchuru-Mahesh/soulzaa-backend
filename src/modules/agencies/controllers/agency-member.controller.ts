import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { RequireRoles } from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacRolesGuard } from 'src/modules/authorization/guards/rbac-roles.guard';
import { AgencyMemberActivityQueryDto } from '../dto/agency-member-activity-query.dto';
import { AgencyMemberPageQueryDto } from '../dto/agency-member-page-query.dto';
import { AgencyMemberPerformanceQueryDto } from '../dto/agency-member-performance-query.dto';
import { AgencyMemberQueryDto } from '../dto/agency-member-query.dto';
import { AgencyMemberActivityService } from '../services/agency-member-activity.service';
import { AgencyMemberHistoryService } from '../services/agency-member-history.service';
import { AgencyMemberPerformanceService } from '../services/agency-member-performance.service';
import { AgencyMemberService } from '../services/agency-member.service';

/**
 * Community Management — the agency's own members.
 *
 * Scoped to the JWT caller exactly as the dashboard is: no `agencyId` is
 * accepted in any form, and the member id in every detail route is checked
 * against this agency's relationships before anything is read. An agency may
 * only see its own users.
 */
@ApiTags('agency-community')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacRolesGuard)
@RequireRoles('AGENCY')
@Controller('agencies/me/members')
export class AgencyMemberController {
  constructor(
    private readonly members: AgencyMemberService,
    private readonly activityService: AgencyMemberActivityService,
    private readonly performanceService: AgencyMemberPerformanceService,
    private readonly historyService: AgencyMemberHistoryService,
  ) {}

  @Get()
  @ApiOperation({ summary: "The calling agency's members, newest joiner first" })
  @ApiResponse({ status: 200, description: 'Paginated members with coins and active state' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: AgencyMemberQueryDto) {
    return this.members.listMembers(user.id, {
      search: query.search,
      page: query.page,
      limit: query.limit,
      filter: query.filter,
    });
  }

  @Get(':userId')
  @ApiOperation({ summary: "One member's Overview tab: identity, badge, stats and rank" })
  @ApiResponse({ status: 404, description: 'Not a member of the calling agency' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.members.getMember(user.id, userId);
  }

  @Get(':userId/activity')
  @ApiOperation({ summary: "One member's activity counters and merged timeline" })
  @ApiResponse({ status: 404, description: 'Not a member of the calling agency' })
  activity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: AgencyMemberActivityQueryDto,
  ) {
    return this.activityService.getActivity(user.id, userId, query);
  }

  @Get(':userId/performance')
  @ApiOperation({ summary: "One member's rank, engagement chart and detail metrics" })
  @ApiResponse({ status: 404, description: 'Not a member of the calling agency' })
  performance(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: AgencyMemberPerformanceQueryDto,
  ) {
    return this.performanceService.getPerformance(user.id, userId, query.range ?? 'month');
  }

  @Get(':userId/rewards')
  @ApiOperation({ summary: 'Rewards this agency has sent to this member' })
  @ApiResponse({ status: 404, description: 'Not a member of the calling agency' })
  rewards(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: AgencyMemberPageQueryDto,
  ) {
    return this.historyService.getRewards(user.id, userId, query);
  }

  @Get(':userId/events')
  @ApiOperation({ summary: 'Platform events this member has joined' })
  @ApiResponse({ status: 404, description: 'Not a member of the calling agency' })
  events(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: AgencyMemberPageQueryDto,
  ) {
    return this.historyService.getEvents(user.id, userId, query);
  }
}
