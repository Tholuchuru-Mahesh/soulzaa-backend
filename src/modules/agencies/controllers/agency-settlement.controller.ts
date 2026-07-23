import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
  AgencyAuditService,
  AgencyConfigurationService,
  AgencyHistoryService,
  AgencyQueryService,
  AgencyRelationshipService,
  AgencyStatisticsService,
} from '../services';

@ApiTags('Agency Settlement Engine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('agency/settlement')
export class AgencySettlementController {
  constructor(
    private readonly queryService: AgencyQueryService,
    private readonly historyService: AgencyHistoryService,
    private readonly statisticsService: AgencyStatisticsService,
    private readonly auditService: AgencyAuditService,
    private readonly configService: AgencyConfigurationService,
    private readonly relationshipService: AgencyRelationshipService,
  ) {}

  @Get('summary')
  @RequirePermissions('agency.settlement.view')
  @ApiOperation({ summary: 'Global Agency Settlement Summary' })
  @ApiResponse({ status: 200, description: 'Global agency settlement metrics' })
  getSummary() {
    return this.queryService.getGlobalSummary();
  }

  @Get('history')
  @RequirePermissions('agency.settlement.history.view')
  @ApiOperation({ summary: 'Agency settlement history logs' })
  @ApiResponse({ status: 200, description: 'Paginated agency settlement history' })
  getHistory(@Query() q: PaginationQueryDto) {
    return this.historyService.getAgencySettlementHistory('', { page: q.page, limit: q.limit });
  }

  @Get('agency/:agencyId')
  @RequirePermissions('agency.settlement.view')
  @ApiOperation({ summary: 'Agency specific settlement history' })
  @ApiResponse({ status: 200, description: 'Agency settlement history' })
  getAgencyEarnings(
    @Param('agencyId', ParseUuidPipe) agencyId: string,
    @Query() q: PaginationQueryDto,
  ) {
    return this.historyService.getAgencySettlementHistory(agencyId, {
      page: q.page,
      limit: q.limit,
    });
  }

  @Get('statistics/:agencyId')
  @RequirePermissions('agency.settlement.view')
  @ApiOperation({ summary: 'Agency daily, weekly, monthly, lifetime statistics' })
  @ApiResponse({ status: 200, description: 'Agency statistics' })
  getAgencyStatistics(@Param('agencyId', ParseUuidPipe) agencyId: string) {
    return this.statisticsService.getAgencyStatistics(agencyId);
  }

  @Get('audit')
  @RequirePermissions('agency.settlement.audit.view')
  @ApiOperation({ summary: 'Agency settlement audit event logs' })
  @ApiResponse({ status: 200, description: 'Audit log entries' })
  getAudit(@Query() q: PaginationQueryDto) {
    return this.auditService.getAuditLogs(undefined, q.page, q.limit);
  }

  @Get('configuration')
  @RequirePermissions('agency.settlement.configuration.manage')
  @ApiOperation({ summary: 'Active dynamic agency commission percentage' })
  @ApiResponse({ status: 200, description: 'Agency configuration' })
  getConfiguration() {
    return this.configService.getCommissionConfig();
  }

  @Put('configuration')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('agency.settlement.configuration.manage')
  @UseInterceptors(AuditLogInterceptor)
  @AuditLogAction('AGENCY_CONFIGURATION_UPDATED', 'agency_configuration')
  @ApiOperation({ summary: 'Update dynamic agency commission configuration parameter' })
  @ApiResponse({ status: 200, description: 'Configuration updated' })
  updateConfiguration(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { key: string; value: any },
  ) {
    return this.configService.updateConfigParameter(body.key, body.value);
  }

  @Get('reports')
  @RequirePermissions('agency.settlement.view')
  @ApiOperation({ summary: 'Top earning agencies report' })
  @ApiResponse({ status: 200, description: 'Top agencies report' })
  getTopAgenciesReport(@Query('limit') limit = 10) {
    return this.queryService.getTopAgencies(Number(limit));
  }

  @Post('relationship/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('agency.settlement.configuration.manage')
  @ApiOperation({ summary: 'Assign a host to an agency' })
  assignHost(@Body() body: { agencyId: string; hostId: string }) {
    return this.relationshipService.assignHostToAgency(body.agencyId, body.hostId);
  }
}
