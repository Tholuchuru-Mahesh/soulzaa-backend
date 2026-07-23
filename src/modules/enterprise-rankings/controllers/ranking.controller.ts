import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { PermissionsGuard } from 'src/common/guards/permission.guard';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import {
  AggregateScoreEventDto,
  CreateRankingDefinitionDto,
  ManualScoreAdjustmentDto,
  TriggerSnapshotDto,
  UpdateRankingConfigurationDto,
  UpdateRankingStatusDto,
} from '../dto/ranking.dto';
import { LeaderboardService } from '../services/leaderboard.service';
import { RankingAggregationService } from '../services/ranking-aggregation.service';
import { RankingAuditService } from '../services/ranking-audit.service';
import { RankingCalculationService } from '../services/ranking-calculation.service';
import { RankingConfigurationService } from '../services/ranking-configuration.service';
import { RankingQueryService } from '../services/ranking-query.service';
import { RankingService } from '../services/ranking.service';
import { RankingSnapshotService } from '../services/ranking-snapshot.service';
import { RankingStatisticsService } from '../services/ranking-statistics.service';

@ApiTags('Enterprise Ranking Engine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditLogInterceptor)
@Controller('enterprise-rankings')
export class EnterpriseRankingController {
  constructor(
    private readonly rankingService: RankingService,
    private readonly leaderboardService: LeaderboardService,
    private readonly calculationService: RankingCalculationService,
    private readonly aggregationService: RankingAggregationService,
    private readonly snapshotService: RankingSnapshotService,
    private readonly statisticsService: RankingStatisticsService,
    private readonly auditService: RankingAuditService,
    private readonly queryService: RankingQueryService,
    private readonly configService: RankingConfigurationService,
  ) {}

  // ─── Ranking Definitions ──────────────────────────────────────────────

  @Post()
  @RequirePermissions('ranking.manage')
  @ApiOperation({ summary: 'Create a new ranking definition' })
  @ApiResponse({ status: 201, description: 'Ranking definition created' })
  async createRanking(@Body() dto: CreateRankingDefinitionDto, @CurrentUser() user: any) {
    return this.rankingService.createRanking({ ...dto, actorId: user?.id });
  }

  @Get()
  @RequirePermissions('ranking.view')
  @ApiOperation({ summary: 'List active ranking definitions' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'status', required: false, example: 'ACTIVE' })
  async getRankings(@Query('category') category?: string, @Query('status') status?: string) {
    return this.rankingService.getRankingDefinitions(category, status ?? 'ACTIVE');
  }

  @Get('categories/:category')
  @RequirePermissions('ranking.view')
  @ApiOperation({ summary: 'Get rankings and top entries by category' })
  async getByCategory(@Param('category') category: string) {
    return this.queryService.getRankingsByCategory(category);
  }

  @Get(':idOrCode')
  @RequirePermissions('ranking.view')
  @ApiOperation({ summary: 'Get a single ranking definition by ID or code' })
  async getRanking(@Param('idOrCode') idOrCode: string) {
    return this.rankingService.getRankingDefinition(idOrCode);
  }

  @Patch(':id/status')
  @RequirePermissions('ranking.manage')
  @ApiOperation({ summary: 'Update ranking definition status' })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateRankingStatusDto,
    @CurrentUser() user: any,
  ) {
    return this.rankingService.updateRankingStatus(id, dto.status, user?.id);
  }

  // ─── Leaderboards ─────────────────────────────────────────────────────

  @Get(':rankingId/leaderboard')
  @RequirePermissions('ranking.view')
  @ApiOperation({ summary: 'Get paginated leaderboard for a ranking definition' })
  @ApiQuery({ name: 'dateKey', required: false, description: 'Specific period date key' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getLeaderboard(
    @Param('rankingId') rankingId: string,
    @Query('dateKey') dateKey?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.leaderboardService.getLeaderboard(
      rankingId,
      dateKey,
      limit ? Number(limit) : 50,
      offset ? Number(offset) : 0,
    );
  }

  @Get('entities/:entityId/position')
  @RequirePermissions('ranking.view')
  @ApiOperation({ summary: 'Get position of an entity in a specific ranking' })
  @ApiQuery({ name: 'rankingId', required: true })
  @ApiQuery({ name: 'dateKey', required: false })
  async getEntityPosition(
    @Param('entityId') entityId: string,
    @Query('rankingId') rankingId: string,
    @Query('dateKey') dateKey?: string,
  ) {
    return this.rankingService.getEntityRankPosition(entityId, rankingId, dateKey);
  }

  @Get('entities/:entityId/rankings')
  @RequirePermissions('ranking.view')
  @ApiOperation({ summary: 'Get all active ranking positions for an entity' })
  async getEntityActiveRankings(@Param('entityId') entityId: string) {
    return this.queryService.getEntityActiveRankings(entityId);
  }

  // ─── Scoring & Manual Adjustments ──────────────────────────────────────

  @Post('manual-adjust')
  @RequirePermissions('ranking.manage')
  @ApiOperation({ summary: 'Admin manual score adjustment for an entity' })
  async manualAdjust(@Body() dto: ManualScoreAdjustmentDto, @CurrentUser() user: any) {
    await this.calculationService.manualAdjust(
      dto.rankingId,
      dto.entityId,
      dto.entityType,
      dto.newScore,
      user?.id,
      dto.reason,
    );
    return { success: true };
  }

  @Post('aggregate-event')
  @RequirePermissions('ranking.manage')
  @ApiOperation({ summary: 'Process a domain event across all matching ranking definitions' })
  async aggregateEvent(@Body() dto: AggregateScoreEventDto, @CurrentUser() user: any) {
    return this.aggregationService.aggregateByEventCode({
      ...dto,
      actorId: user?.id,
    });
  }

  // ─── Snapshots ────────────────────────────────────────────────────────

  @Post('snapshots/trigger')
  @RequirePermissions('ranking.manage')
  @ApiOperation({ summary: 'Trigger a manual snapshot for a ranking definition' })
  async triggerSnapshot(@Body() dto: TriggerSnapshotDto, @CurrentUser() user: any) {
    return this.snapshotService.takeSnapshot({
      ...dto,
      actorId: user?.id,
    });
  }

  @Post('snapshots/trigger-all')
  @RequirePermissions('ranking.manage')
  @ApiOperation({ summary: 'Trigger manual snapshots for all active ranking definitions' })
  async triggerAllSnapshots(@CurrentUser() user: any) {
    return this.snapshotService.takeAllSnapshots(user?.id);
  }

  @Get(':rankingId/snapshots')
  @RequirePermissions('ranking.view')
  @ApiOperation({ summary: 'Get snapshots for a ranking definition' })
  @ApiQuery({ name: 'period', required: false })
  @ApiQuery({ name: 'dateKey', required: false })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getSnapshots(
    @Param('rankingId') rankingId: string,
    @Query('period') period?: string,
    @Query('dateKey') dateKey?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.snapshotService.getSnapshots(
      rankingId,
      period,
      dateKey,
      limit ? Number(limit) : 50,
      offset ? Number(offset) : 0,
    );
  }

  // ─── Statistics ────────────────────────────────────────────────────────

  @Get('statistics/platform')
  @RequirePermissions('ranking.statistics.view')
  @ApiOperation({ summary: 'Get platform-wide ranking statistics' })
  async getPlatformStatistics() {
    return this.statisticsService.getPlatformSummary();
  }

  @Get('statistics/categories/:category')
  @RequirePermissions('ranking.statistics.view')
  @ApiOperation({ summary: 'Get statistics for a specific category' })
  async getCategoryStatistics(@Param('category') category: string) {
    return this.statisticsService.getCategoryStatistics(category);
  }

  @Get('statistics/top/:category')
  @RequirePermissions('ranking.statistics.view')
  @ApiOperation({ summary: 'Get top entities in a category' })
  async getTopEntities(@Param('category') category: string) {
    return this.statisticsService.getTopEntities(category);
  }

  // ─── History & Audit ──────────────────────────────────────────────────

  @Get('entities/:entityId/history')
  @RequirePermissions('ranking.view')
  @ApiOperation({ summary: 'Get historical score change events for an entity' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getEntityHistory(
    @Param('entityId') entityId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.queryService.getEntityRankingHistory(
      entityId,
      limit ? Number(limit) : 50,
      offset ? Number(offset) : 0,
    );
  }

  @Get('audit')
  @RequirePermissions('ranking.audit.view')
  @ApiOperation({ summary: 'Get operational audit logs for the ranking engine' })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getAuditLogs(
    @Query('entityId') entityId?: string,
    @Query('action') action?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.auditService.getLogs(
      entityId,
      action,
      limit ? Number(limit) : 50,
      offset ? Number(offset) : 0,
    );
  }

  // ─── Configuration ────────────────────────────────────────────────────

  @Get('configuration')
  @RequirePermissions('ranking.configuration.manage')
  @ApiOperation({ summary: 'List all ranking engine configuration parameters' })
  async listConfiguration() {
    return this.configService.listConfigurations();
  }

  @Post('configuration')
  @RequirePermissions('ranking.configuration.manage')
  @ApiOperation({ summary: 'Set a dynamic ranking engine configuration parameter' })
  async setConfiguration(
    @Body() dto: UpdateRankingConfigurationDto,
    @CurrentUser() user: any,
  ) {
    return this.configService.setConfiguration(dto.key, dto.value, user?.id);
  }
}
