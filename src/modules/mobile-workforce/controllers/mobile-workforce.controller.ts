import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { MobileWorkforceService } from '../services/mobile-workforce.service';

/**
 * Mobile console for the operational workforce — Country Manager, Official and
 * Moderator.
 *
 * Gated on `mobile.workforce.view`. Every route derives its subject from the
 * authenticated user rather than a parameter, so one operator cannot read
 * another's territory by editing a request, and results are narrowed to the
 * caller's geographic scope.
 */
@ApiTags('Mobile — Workforce')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@RequirePermissions('mobile.workforce.view')
@Controller('mobile/workforce')
export class MobileWorkforceController {
  constructor(private readonly service: MobileWorkforceService) {}

  @ApiOperation({ summary: 'My geographic scope and what it resolves to' })
  @ApiResponse({ status: 200, description: 'Scope assignments and effective countries' })
  @Get('me/scope')
  myScope(@CurrentUser('id') userId: string) {
    return this.service.myScope(userId);
  }

  @ApiOperation({ summary: 'Population summary within my scope' })
  @ApiResponse({ status: 200, description: 'Scoped user counts by standing' })
  @Get('summary')
  summary(@CurrentUser('id') userId: string) {
    return this.service.summary(userId);
  }

  @ApiOperation({ summary: 'Users within my scope' })
  @ApiQuery({ name: 'q', required: false, description: 'Username or email search' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size (default 25, max 100)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Page offset (default 0)' })
  @ApiResponse({ status: 200, description: 'Scoped, paginated user list' })
  @Get('users')
  users(
    @CurrentUser('id') userId: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.users(userId, q, Number(limit) || 25, Number(offset) || 0);
  }

  @ApiOperation({ summary: 'Pending moderation reports within my scope' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size (default 25, max 100)' })
  @ApiResponse({ status: 200, description: 'Scoped pending report queue' })
  @Get('moderation/queue')
  moderationQueue(@CurrentUser('id') userId: string, @Query('limit') limit?: string) {
    return this.service.moderationQueue(userId, Number(limit) || 25);
  }

  @ApiOperation({ summary: 'Investigation reports assigned specifically to current moderator' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size (default 25, max 100)' })
  @ApiResponse({ status: 200, description: 'Assigned audio and video report queue' })
  @Get('me/assigned-queue')
  myAssignedQueue(@CurrentUser('id') userId: string, @Query('limit') limit?: string) {
    return this.service.myAssignedQueue(userId, Number(limit) || 25);
  }

  @ApiOperation({ summary: 'Tasks assigned to the current moderator' })
  @ApiResponse({ status: 200, description: 'List of moderator tasks' })
  @Get('me/tasks')
  moderatorTasks(@CurrentUser('id') userId: string) {
    return this.service.moderatorTasks(userId);
  }

  @ApiOperation({ summary: 'Complete Moderator Mobile Dashboard overview' })
  @ApiResponse({ status: 200, description: 'Aggregated scope, shift, stats, and queue' })
  @Get('me/dashboard')
  moderatorDashboard(@CurrentUser('id') userId: string) {
    return this.service.moderatorDashboard(userId);
  }
  @ApiOperation({
    summary: 'Official Portal dashboard — all metrics in one call',
    description:
      'Returns regionalOverview (8 counters), pendingActions (6 counters) and ' +
      "runningActivities (3 counters), all narrowed to the caller's geographic scope. " +
      'No hardcoded data — every number is a live DB count.',
  })
  @ApiResponse({
    status: 200,
    description: 'Dashboard snapshot with counters for the Official mobile portal',
  })
  @Get('dashboard')
  dashboard(@CurrentUser('id') userId: string) {
    return this.service.dashboard(userId);
  }

  @ApiOperation({ summary: 'Live room details, chat messages, active reports, and participants' })
  @ApiResponse({ status: 200, description: 'Live monitoring details for specific room' })
  @Get('rooms/:roomId/details')
  roomDetails(
    @CurrentUser('id') userId: string,
    @Query('roomId') queryRoomId?: string,
    @Query('id') queryId?: string,
  ) {
    const roomId = queryRoomId || queryId || '';
    return this.service.roomDetails(userId, roomId);
  }

  @ApiOperation({ summary: 'Submit moderation decision on report' })
  @ApiResponse({ status: 200, description: 'Moderation decision applied' })
  @Post('reports/:reportId/decision')
  actionReport(
    @CurrentUser('id') userId: string,
    @Param('reportId') reportId: string,
    @Body() body: { action: string; note?: string },
  ) {
    return this.service.actionReport(userId, reportId, body);
  }

  @ApiOperation({ summary: 'Apply moderation action to room participant' })
  @ApiResponse({ status: 200, description: 'Participant moderation action applied' })
  @Post('rooms/:roomId/participants/:targetUserId/action')
  moderateParticipant(
    @CurrentUser('id') userId: string,
    @Param('roomId') roomId: string,
    @Param('targetUserId') targetUserId: string,
    @Body() body: { action: string; reason?: string },
  ) {
    return this.service.moderateParticipant(userId, roomId, targetUserId, body);
  }

  @ApiOperation({ summary: 'Mark moderator task as completed' })
  @ApiResponse({ status: 200, description: 'Task marked as completed' })
  @Post('tasks/:taskId/complete')
  completeTask(@CurrentUser('id') userId: string, @Param('taskId') taskId: string) {
    return this.service.completeTask(userId, taskId);
  }

  @ApiOperation({ summary: 'Detailed Agency information for Official Portal' })
  @ApiResponse({ status: 200, description: 'Agency profile, metrics, contact, and recent activities' })
  @Get('agencies/:id')
  agencyDetails(@CurrentUser('id') userId: string, @Param('id') agencyId: string) {
    return this.service.agencyDetails(userId, agencyId);
  }

  @ApiOperation({ summary: 'List of complaints for Agency' })
  @ApiResponse({ status: 200, description: 'Complaints list and breakdown metrics' })
  @Get('agencies/:id/complaints')
  agencyComplaints(@CurrentUser('id') userId: string, @Param('id') agencyId: string) {
    return this.service.agencyComplaints(userId, agencyId);
  }

  @ApiOperation({ summary: 'Resolve or Escalate an Agency Complaint' })
  @ApiResponse({ status: 200, description: 'Complaint actioned' })
  @Post('agencies/:id/complaints/:complaintId/action')
  actionAgencyComplaint(
    @CurrentUser('id') userId: string,
    @Param('id') agencyId: string,
    @Param('complaintId') complaintId: string,
    @Body() body: { action: 'RESOLVE' | 'ESCALATE'; note?: string },
  ) {
    return this.service.actionAgencyComplaint(userId, agencyId, complaintId, body);
  }

  @ApiOperation({ summary: 'List of creators and metrics for Official Portal' })
  @ApiResponse({ status: 200, description: 'Creators list and metrics' })
  @Get('creators')
  creatorsList(
    @CurrentUser('id') userId: string,
    @Query('search') search?: string,
    @Query('category') category?: string,
  ) {
    return this.service.creatorsList(userId, { search, category });
  }

  @ApiOperation({ summary: 'Detailed Creator information for Official Portal' })
  @ApiResponse({ status: 200, description: 'Creator profile, overview metrics, and recent activities' })
  @Get('creators/:id')
  creatorDetails(
    @CurrentUser('id') userId: string,
    @Param('id') creatorId: string,
  ) {
    return this.service.creatorDetails(userId, creatorId);
  }

  @ApiOperation({ summary: 'List of recommendations and metrics for Official Portal' })
  @ApiResponse({ status: 200, description: 'Recommendations list and metrics' })
  @Get('recommendations')
  recommendationsList(
    @CurrentUser('id') userId: string,
    @Query('search') search?: string,
    @Query('role') role?: string,
  ) {
    return this.service.recommendationsList(userId, { search, role });
  }

  @ApiOperation({ summary: 'Search candidate users for recommendation' })
  @ApiResponse({ status: 200, description: 'Candidate users matching search query' })
  @Get('recommendations/candidates/search')
  searchCandidates(
    @CurrentUser('id') userId: string,
    @Query('query') query?: string,
    @Query('q') q?: string,
    @Query('search') search?: string,
  ) {
    return this.service.searchCandidates(userId, query || q || search || '');
  }


  @ApiOperation({ summary: 'Detailed recommendation info for Official Portal' })
  @ApiResponse({ status: 200, description: 'Candidate info, verification status, and history' })
  @Get('recommendations/:id')
  recommendationDetails(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.service.recommendationDetails(userId, id);
  }

  @ApiOperation({ summary: 'Submit a new recommendation for Official Portal' })
  @ApiResponse({ status: 201, description: 'Recommendation submitted' })
  @Post('recommendations')
  createRecommendation(
    @CurrentUser('id') userId: string,
    @Body()
    body: {
      candidateUserId: string;
      roleType: 'MODERATOR' | 'BUSINESS_DEVELOPMENT' | 'CREATOR' | 'HOST';
      reason: string;
      region?: string;
    },
  ) {
    return this.service.createRecommendation(userId, body);
  }
}





