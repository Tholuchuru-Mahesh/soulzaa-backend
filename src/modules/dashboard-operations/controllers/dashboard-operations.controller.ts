import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { DashboardOperationsService } from '../services/dashboard-operations.service';

/**
 * Operations web dashboards for the admin console: platform overview, users,
 * events, tasks & missions, notifications and analytics.
 *
 * Gated on `dashboard.operations.view` — ADMIN only, SUPER_ADMIN via wildcard.
 */
@ApiTags('Dashboard — Operations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@RequirePermissions('dashboard.operations.view')
@Controller('dashboard/operations')
export class DashboardOperationsController {
  constructor(private readonly service: DashboardOperationsService) {}

  @ApiOperation({ summary: 'Platform overview — population, live rooms, daily actives' })
  @ApiResponse({ status: 200, description: 'Top-level platform health counters' })
  @Get('overview')
  overview() {
    return this.service.platformOverview();
  }

  @ApiOperation({ summary: 'User overview — status mix, role distribution, new signups' })
  @ApiQuery({ name: 'recent', required: false, description: 'Signup list size (default 25)' })
  @ApiResponse({ status: 200, description: 'User population breakdown' })
  @Get('users')
  users(@Query('recent') recent?: string) {
    return this.service.userOverview(Number(recent) || 25);
  }

  @ApiOperation({ summary: 'Events management — lifecycle mix and running events' })
  @ApiQuery({ name: 'limit', required: false, description: 'Active event list size (default 25)' })
  @ApiResponse({ status: 200, description: 'Event counts by status and active events' })
  @Get('events')
  events(@Query('limit') limit?: string) {
    return this.service.eventsDashboard(Number(limit) || 25);
  }

  @ApiOperation({ summary: 'Task & mission management — definitions and completion rate' })
  @ApiResponse({ status: 200, description: 'Task and mission throughput' })
  @Get('tasks')
  tasks() {
    return this.service.tasksDashboard();
  }

  @ApiOperation({ summary: 'Notification centre — volume and per-channel delivery health' })
  @ApiResponse({ status: 200, description: 'Notification delivery statistics' })
  @Get('notifications')
  notifications() {
    return this.service.notificationsDashboard();
  }

  @ApiOperation({ summary: 'Analytics dashboard — reports, snapshots and exports' })
  @ApiQuery({ name: 'recent', required: false, description: 'Report list size (default 20)' })
  @ApiResponse({ status: 200, description: 'Analytics engine activity' })
  @Get('analytics')
  analytics(@Query('recent') recent?: string) {
    return this.service.analyticsDashboard(Number(recent) || 20);
  }
}
