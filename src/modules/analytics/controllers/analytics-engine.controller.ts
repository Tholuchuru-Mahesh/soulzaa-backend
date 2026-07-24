import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { ReportService } from '../services/report.service';
import { DashboardService } from '../services/dashboard.service';
import { TrendService } from '../services/trend.service';
import { ExportService } from '../services/export.service';
import { AnalyticsStatisticsService } from '../services/analytics-statistics.service';
import { AnalyticsAuditService } from '../services/analytics-audit.service';
import { AnalyticsConfigurationService } from '../services/analytics-configuration.service';
import { AnalyticsQueryService } from '../services/analytics-query.service';
import { AnalyticsValidationService } from '../services/analytics-validation.service';
import { AnalyticsCenterService } from '../services/analytics-center.service';
import {
  GenerateReportDto,
  ExportReportDto,
  CreateDashboardDto,
  QueryTrendDto,
  UpdateLayoutDto,
  UpdateConfigDto,
} from '../dto/analytics-engine.dto';

@ApiTags('Analytics Engine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('analytics-engine')
export class AnalyticsEngineController {
  constructor(
    private readonly reportService: ReportService,
    private readonly dashboardService: DashboardService,
    private readonly trendService: TrendService,
    private readonly exportService: ExportService,
    private readonly statisticsService: AnalyticsStatisticsService,
    private readonly auditService: AnalyticsAuditService,
    private readonly configService: AnalyticsConfigurationService,
    private readonly queryService: AnalyticsQueryService,
    private readonly validation: AnalyticsValidationService,
    private readonly centerService: AnalyticsCenterService,
  ) {}

  // ── Report Endpoints ──────────────────────────────────────────────
  @Post('reports')
  @RequirePermissions('analytics.manage')
  @ApiOperation({ summary: 'Generate a new domain analytics report' })
  @ApiResponse({ status: 201, description: 'Report compiled.' })
  async generateReport(@Body() dto: GenerateReportDto) {
    this.validation.assertValidDomain(dto.domain);
    return this.reportService.generateReport(dto);
  }

  @Get('reports')
  @RequirePermissions('analytics.view')
  @ApiOperation({ summary: 'List generated reports' })
  @ApiQuery({ name: 'domain', required: false })
  @ApiQuery({ name: 'skip', required: false })
  @ApiQuery({ name: 'take', required: false })
  async listReports(
    @Query('domain') domain?: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    if (domain) this.validation.assertValidDomain(domain);
    return this.queryService.getReportsList(domain, parseInt(skip), parseInt(take));
  }

  @Get('reports/:id')
  @RequirePermissions('analytics.view')
  @ApiOperation({ summary: 'Get report details with aggregate metrics' })
  async getReport(@Param('id', ParseUUIDPipe) id: string) {
    return this.queryService.getReportDetails(id);
  }

  // ── Export Endpoints ──────────────────────────────────────────────
  @Post('exports')
  @RequirePermissions('analytics.export')
  @ApiOperation({ summary: 'Request format export of compiled report' })
  async exportReport(@Body() dto: ExportReportDto) {
    await this.validation.assertReportExists(dto.reportId);
    this.validation.assertValidFormat(dto.format);
    return this.exportService.exportReport(dto);
  }

  @Get('exports/:id')
  @RequirePermissions('analytics.view')
  @ApiOperation({ summary: 'Check status of export file download' })
  async getExport(@Param('id', ParseUUIDPipe) id: string) {
    return this.exportService.getExportStatus(id);
  }

  // ── Dashboard Endpoints ───────────────────────────────────────────
  @Post('dashboards')
  @RequirePermissions('analytics.manage')
  @ApiOperation({ summary: 'Create a new dashboard configuration' })
  async createDashboard(@Body() dto: CreateDashboardDto) {
    return this.dashboardService.create(dto);
  }

  @Get('dashboards')
  @RequirePermissions('analytics.view')
  @ApiOperation({ summary: 'List all custom dashboard layouts' })
  async listDashboards() {
    return this.dashboardService.listDashboards();
  }

  @Get('dashboards/:id')
  @RequirePermissions('analytics.view')
  @ApiOperation({ summary: 'Get dashboard widgets and metric mappings' })
  async getDashboard(@Param('id', ParseUUIDPipe) id: string) {
    return this.dashboardService.getDashboard(id);
  }

  @Patch('dashboards/:id/layout')
  @RequirePermissions('analytics.manage')
  @ApiOperation({ summary: 'Update dashboard grid layout' })
  async updateLayout(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLayoutDto,
  ) {
    await this.validation.assertDashboardExists(id);
    await this.dashboardService.updateLayout(id, dto.layout);
    return { message: 'Dashboard layout updated.' };
  }

  // ── Time-series Trends ────────────────────────────────────────────
  @Post('trends')
  @RequirePermissions('analytics.view')
  @ApiOperation({ summary: 'Retrieve time-series trend snapshot values' })
  async queryTrends(@Body() dto: QueryTrendDto) {
    this.validation.assertValidDomain(dto.domain);
    this.validation.assertValidDateRange(dto.startDate, dto.endDate);
    return this.trendService.getTrendData({
      domain: dto.domain,
      metricKey: dto.metricKey,
      startDate: new Date(dto.startDate),
      endDate: new Date(dto.endDate),
    });
  }

  // ── Statistics Summary ────────────────────────────────────────────
  @Get('statistics/summary')
  @RequirePermissions('analytics.statistics.view')
  @ApiOperation({ summary: 'Get aggregation statistical period metrics' })
  @ApiQuery({ name: 'period', required: true })
  @ApiQuery({ name: 'dateKey', required: true })
  async getStatsSummary(
    @Query('period') period: string,
    @Query('dateKey') dateKey: string,
  ) {
    return this.statisticsService.getSummary(period, dateKey);
  }

  // ── Snapshot Action ───────────────────────────────────────────────
  @Post('snapshots/trigger')
  @RequirePermissions('analytics.manage')
  @ApiOperation({ summary: 'Manually trigger periodic snapshot capturing cycle' })
  async triggerSnapshots() {
    await this.centerService.captureSnapshots();
    return { message: 'Aggregated snapshot capture initiated.' };
  }

  // ── Audit Logs ────────────────────────────────────────────────────
  @Get('audit/all')
  @RequirePermissions('analytics.audit.view')
  @ApiOperation({ summary: 'Retrieve operational analytics audit trail logs' })
  @ApiQuery({ name: 'skip', required: false })
  @ApiQuery({ name: 'take', required: false })
  async listAudits(
    @Query('skip') skip = '0',
    @Query('take') take = '100',
  ) {
    return this.auditService.findAll(parseInt(skip), parseInt(take));
  }

  // ── Configuration Endpoints ───────────────────────────────────────
  @Get('configuration')
  @RequirePermissions('analytics.configuration.manage')
  @ApiOperation({ summary: 'Retrieve dynamic configurations' })
  async getConfig() {
    return this.configService.getAll();
  }

  @Patch('configuration')
  @RequirePermissions('analytics.configuration.manage')
  @ApiOperation({ summary: 'Set dynamic configuration key-value value' })
  async setConfig(@Body() dto: UpdateConfigDto) {
    await this.configService.set(dto.key, dto.value);
    return { message: 'Analytics configuration updated.' };
  }
}
