import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  AuditLogAction,
  RequirePermissions,
} from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import {
  HostEarningsService,
  RevenueAuditService,
  RevenueConfigurationService,
  RevenueHistoryService,
  RevenueQueryService,
  RevenueStatisticsService,
} from '../services';

@ApiTags('Host Earnings & Revenue Distribution Engine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('revenue')
export class RevenueController {
  constructor(
    private readonly queryService: RevenueQueryService,
    private readonly historyService: RevenueHistoryService,
    private readonly hostEarningsService: HostEarningsService,
    private readonly statisticsService: RevenueStatisticsService,
    private readonly auditService: RevenueAuditService,
    private readonly configService: RevenueConfigurationService,
  ) {}

  @Get('summary')
  @RequirePermissions('revenue.view')
  @ApiOperation({ summary: 'Global Revenue & Host Earnings Summary' })
  @ApiResponse({ status: 200, description: 'Global revenue metrics' })
  getSummary() {
    return this.queryService.getGlobalSummary();
  }

  @Get('history')
  @RequirePermissions('revenue.history.view')
  @ApiOperation({ summary: 'Revenue distribution history log' })
  @ApiResponse({ status: 200, description: 'Paginated revenue history' })
  getHistory(@Query() q: PaginationQueryDto) {
    return this.historyService.getHostDistributionHistory('', { page: q.page, limit: q.limit });
  }

  @Get('host/:hostId')
  @RequirePermissions('revenue.view')
  @ApiOperation({ summary: 'Host cumulative earnings summary' })
  @ApiResponse({ status: 200, description: 'Host summary' })
  getHostEarnings(@Param('hostId', ParseUuidPipe) hostId: string) {
    return this.hostEarningsService.getHostSummary(hostId);
  }

  @Get('host/:hostId/history')
  @RequirePermissions('revenue.history.view')
  @ApiOperation({ summary: 'Host specific revenue distribution history' })
  @ApiResponse({ status: 200, description: 'Host distribution history' })
  getHostHistory(@Param('hostId', ParseUuidPipe) hostId: string, @Query() q: PaginationQueryDto) {
    return this.historyService.getHostDistributionHistory(hostId, { page: q.page, limit: q.limit });
  }

  @Get('room/:roomId')
  @RequirePermissions('revenue.view')
  @ApiOperation({ summary: 'Room total revenue history' })
  @ApiResponse({ status: 200, description: 'Room revenue history' })
  getRoomRevenue(@Param('roomId', ParseUuidPipe) roomId: string, @Query() q: PaginationQueryDto) {
    return this.historyService.getRoomRevenueHistory(roomId, { page: q.page, limit: q.limit });
  }

  @Get('statistics/:hostId')
  @RequirePermissions('revenue.view')
  @ApiOperation({ summary: 'Host daily, weekly, monthly, lifetime revenue statistics' })
  @ApiResponse({ status: 200, description: 'Host revenue statistics' })
  getHostStatistics(@Param('hostId', ParseUuidPipe) hostId: string) {
    return this.statisticsService.getHostStatistics(hostId);
  }

  @Get('audit')
  @RequirePermissions('revenue.audit.view')
  @ApiOperation({ summary: 'Revenue audit event logs' })
  @ApiResponse({ status: 200, description: 'Audit log entries' })
  getAudit(@Query() q: PaginationQueryDto) {
    return this.auditService.getAuditLogs(undefined, q.page, q.limit);
  }

  @Get('configuration')
  @RequirePermissions('revenue.configuration.manage')
  @ApiOperation({ summary: 'Active dynamic revenue split percentages' })
  @ApiResponse({ status: 200, description: 'Revenue configuration' })
  getConfiguration() {
    return this.configService.getRevenueSplitConfig();
  }

  @Put('configuration')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('revenue.configuration.manage')
  @UseInterceptors(AuditLogInterceptor)
  @AuditLogAction('REVENUE_CONFIGURATION_UPDATED', 'revenue_configuration')
  @ApiOperation({ summary: 'Update dynamic revenue split configuration parameter' })
  @ApiResponse({ status: 200, description: 'Configuration updated' })
  updateConfiguration(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { key: string; value: any },
  ) {
    return this.configService.updateConfigParameter(body.key, body.value);
  }

  @Get('reports')
  @RequirePermissions('revenue.view')
  @ApiOperation({ summary: 'Top earning hosts report' })
  @ApiResponse({ status: 200, description: 'Top hosts report' })
  getTopHostsReport(@Query('limit') limit = 10) {
    return this.queryService.getTopHosts(Number(limit));
  }
}
