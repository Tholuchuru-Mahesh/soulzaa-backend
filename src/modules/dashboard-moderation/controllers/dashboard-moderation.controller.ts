import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { DashboardModerationService } from '../services/dashboard-moderation.service';

/**
 * Moderation web dashboards for the admin console: the report queue and the
 * operational audit log.
 *
 * Gated on `dashboard.moderation.view` — ADMIN only, SUPER_ADMIN via wildcard.
 * Read-only: actioning a report goes through the room moderation services, which
 * apply the rank rules.
 */
@ApiTags('Dashboard — Moderation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@RequirePermissions('dashboard.moderation.view')
@Controller('dashboard/moderation')
export class DashboardModerationController {
  constructor(private readonly service: DashboardModerationService) {}

  @ApiOperation({ summary: 'Moderation dashboard — report queue and enforcement volume' })
  @ApiQuery({ name: 'limit', required: false, description: 'Queue page size (default 25)' })
  @ApiResponse({ status: 200, description: 'Pending reports, appeals and enforcement counts' })
  @Get('overview')
  overview(@Query('limit') limit?: string) {
    return this.service.moderationDashboard(Number(limit) || 25);
  }

  @ApiOperation({ summary: 'Operational logs — privileged-action audit trail' })
  @ApiQuery({ name: 'actorId', required: false, description: 'Filter by acting user' })
  @ApiQuery({ name: 'action', required: false, description: 'Filter by audit action code' })
  @ApiQuery({ name: 'resource', required: false, description: 'Filter by resource type' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size (default 50, max 200)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Page offset (default 0)' })
  @ApiResponse({ status: 200, description: 'Audit log entries and top actions' })
  @Get('logs')
  logs(
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
    @Query('resource') resource?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.operationalLogs({
      actorId,
      action,
      resource,
      limit: Number(limit) || 50,
      offset: Number(offset) || 0,
    });
  }
}
