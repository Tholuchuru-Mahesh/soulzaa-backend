import { Controller, Get, Query, UseGuards } from '@nestjs/common';
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
}
