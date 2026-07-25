import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { AdminDashboardService } from '../services/admin-dashboard.service';
import { DashboardWidgetService } from '../services/dashboard-widget.service';
import { DashboardStatisticsService } from '../services/dashboard-statistics.service';
import { DashboardQueryService } from '../services/dashboard-query.service';
import { DashboardAuditService } from '../services/dashboard-audit.service';
import { DashboardConfigurationService } from '../services/dashboard-configuration.service';
import { DashboardHealthService } from '../services/dashboard-health.service';
import { DashboardExportService } from '../services/dashboard-export.service';
import { DashboardValidationService } from '../services/dashboard-validation.service';
import {
  CreateWidgetDto,
  UpdateWidgetConfigDto,
  CreateLayoutDto,
  ExportLayoutDto,
  UpdateConfigDto,
} from '../dto/dashboard.dto';

@ApiTags('Business Admin Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('admin-dashboard')
export class DashboardController {
  constructor(
    private readonly dashboardService: AdminDashboardService,
    private readonly widgetService: DashboardWidgetService,
    private readonly statisticsService: DashboardStatisticsService,
    private readonly queryService: DashboardQueryService,
    private readonly auditService: DashboardAuditService,
    private readonly configService: DashboardConfigurationService,
    private readonly healthService: DashboardHealthService,
    private readonly exportService: DashboardExportService,
    private readonly validation: DashboardValidationService,
  ) {}

  // ── Overview Endpoints ────────────────────────────────────────────
  @Get('overview')
  @RequirePermissions('dashboard.view')
  @ApiOperation({ summary: 'Retrieve system-wide aggregated operational KPIs overview' })
  async getOverview(@Req() req: any) {
    const userId = req.user?.id;
    if (userId) {
      await this.dashboardService.markDashboardViewed(userId);
    }
    return this.queryService.getOverviewStats();
  }

  @Get('search')
  @RequirePermissions('dashboard.view')
  @ApiOperation({ summary: 'Cross-module global administration query search' })
  @ApiQuery({ name: 'q', required: true })
  async search(@Query('q') q: string) {
    return this.queryService.searchGlobal(q);
  }

  // ── Health Diagnostics ────────────────────────────────────────────
  @Get('health')
  @RequirePermissions('dashboard.view')
  @ApiOperation({ summary: 'Retrieve real-time platform system health reports' })
  async getHealthReport() {
    return this.healthService.checkHealth();
  }

  @Get('health/alerts')
  @RequirePermissions('dashboard.view')
  @ApiOperation({ summary: 'Get active raised system status warning alerts' })
  async getHealthAlerts() {
    return this.healthService.getActiveAlerts();
  }

  @Patch('health/alerts/:id/resolve')
  @RequirePermissions('dashboard.manage')
  @ApiOperation({ summary: 'Resolve an active raised system warning alert' })
  async resolveAlert(@Param('id', ParseUUIDPipe) id: string) {
    await this.healthService.resolveAlert(id);
    return { message: 'Alert resolved.' };
  }

  // ── Widgets ───────────────────────────────────────────────────────
  @Post('widgets')
  @RequirePermissions('dashboard.manage')
  @ApiOperation({ summary: 'Create and register operational metric widget block' })
  async createWidget(@Body() dto: CreateWidgetDto) {
    return this.widgetService.createWidget(dto);
  }

  @Get('widgets')
  @RequirePermissions('dashboard.view')
  @ApiOperation({ summary: 'Get list of visible registered dashboard widgets' })
  async listWidgets(@Req() req: any) {
    const role = req.user?.role ?? 'USER';
    return this.widgetService.listWidgets(role);
  }

  @Get('widgets/:id')
  @RequirePermissions('dashboard.view')
  @ApiOperation({ summary: 'Get widget details if user role has visibility access' })
  async getWidget(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const role = req.user?.role ?? 'USER';
    return this.widgetService.getWidget(id, role);
  }

  @Patch('widgets/:id/config')
  @RequirePermissions('dashboard.manage')
  @ApiOperation({ summary: 'Update widget layout and display configuration settings' })
  async updateWidget(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWidgetConfigDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    await this.widgetService.updateWidgetConfig(id, dto.config, userId);
    return { message: 'Widget configuration updated.' };
  }

  // ── Layouts ───────────────────────────────────────────────────────
  @Post('layouts')
  @RequirePermissions('dashboard.manage')
  @ApiOperation({ summary: 'Register personalized console layout grid configurations' })
  async createLayout(@Body() dto: CreateLayoutDto, @Req() req: any) {
    const userId = req.user?.id;
    return this.dashboardService.createLayout({
      userId,
      name: dto.name,
      isDefault: dto.isDefault,
      gridConfig: dto.gridConfig,
    });
  }

  @Get('layouts/user')
  @RequirePermissions('dashboard.view')
  @ApiOperation({ summary: 'Retrieve layouts registered for current user' })
  async getUserLayouts(@Req() req: any) {
    const userId = req.user?.id;
    return this.dashboardService.getUserLayouts(userId);
  }

  // ── Exports ───────────────────────────────────────────────────────
  @Post('exports')
  @RequirePermissions('dashboard.export')
  @ApiOperation({ summary: 'Export dashboard layout state report' })
  async exportDashboard(@Body() dto: ExportLayoutDto, @Req() req: any) {
    const userId = req.user?.id;
    this.validation.assertValidExportFormat(dto.format);
    return this.exportService.exportDashboard({
      layoutId: dto.layoutId,
      format: dto.format,
      userId,
    });
  }

  // ── Statistics ────────────────────────────────────────────────────
  @Get('statistics/summary')
  @RequirePermissions('dashboard.statistics.view')
  @ApiOperation({ summary: 'Retrieve console operation stats counts' })
  @ApiQuery({ name: 'period', required: true })
  @ApiQuery({ name: 'dateKey', required: true })
  async getStatsSummary(@Query('period') period: string, @Query('dateKey') dateKey: string) {
    return this.statisticsService.getSummary(period, dateKey);
  }

  // ── Audit Logs ────────────────────────────────────────────────────
  @Get('audit/all')
  @RequirePermissions('dashboard.audit.view')
  @ApiOperation({ summary: 'Retrieve administrative audit logs' })
  @ApiQuery({ name: 'skip', required: false })
  @ApiQuery({ name: 'take', required: false })
  async listAudits(@Query('skip') skip = '0', @Query('take') take = '100') {
    return this.auditService.findAll(parseInt(skip), parseInt(take));
  }

  // ── Configuration ──────────────────────────────────────────────────
  @Get('configuration')
  @RequirePermissions('dashboard.configuration.manage')
  @ApiOperation({ summary: 'Get dynamic configs' })
  async getConfig() {
    return this.configService.getAll();
  }

  @Patch('configuration')
  @RequirePermissions('dashboard.configuration.manage')
  @ApiOperation({ summary: 'Set dynamic config parameter values' })
  async setConfig(@Body() dto: UpdateConfigDto) {
    await this.configService.set(dto.key, dto.value);
    return { message: 'Dashboard configuration updated.' };
  }
}
