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
  AdminGrantBadgeDto,
  ClaimRewardDto,
  CreateAchievementDto,
  CreateBadgeDto,
  EquipBadgeDto,
  EvaluateEventDto,
  ManualGrantAchievementDto,
  UpdateAchievementConfigurationDto,
  UpdateAchievementStatusDto,
} from '../dto/achievement.dto';
import { AchievementAuditService } from '../services/achievement-audit.service';
import { AchievementConfigurationService } from '../services/achievement-configuration.service';
import { AchievementEvaluationService } from '../services/achievement-evaluation.service';
import { AchievementProgressService } from '../services/achievement-progress.service';
import { AchievementQueryService } from '../services/achievement-query.service';
import { AchievementRewardService } from '../services/achievement-reward.service';
import { AchievementService } from '../services/achievement.service';
import { AchievementStatisticsService } from '../services/achievement-statistics.service';
import { BadgeService } from '../services/badge.service';

@ApiTags('Enterprise Badge & Achievement Engine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditLogInterceptor)
@Controller('achievements')
export class AchievementController {
  constructor(
    private readonly achievementService: AchievementService,
    private readonly badgeService: BadgeService,
    private readonly progressService: AchievementProgressService,
    private readonly evaluationService: AchievementEvaluationService,
    private readonly rewardService: AchievementRewardService,
    private readonly statisticsService: AchievementStatisticsService,
    private readonly auditService: AchievementAuditService,
    private readonly queryService: AchievementQueryService,
    private readonly configService: AchievementConfigurationService,
  ) {}

  // ─── Achievement Definitions ──────────────────────────────────────────────

  @Post()
  @RequirePermissions('achievement.manage')
  @ApiOperation({ summary: 'Create a new achievement definition' })
  @ApiResponse({ status: 201, description: 'Achievement definition created' })
  async createAchievement(@Body() dto: CreateAchievementDto, @CurrentUser() user: any) {
    return this.achievementService.createAchievement({
      ...dto,
      actorId: user?.id,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    });
  }

  @Get()
  @RequirePermissions('achievement.view')
  @ApiOperation({ summary: 'List achievement definitions' })
  @ApiQuery({ name: 'category', required: false, description: 'Filter by category' })
  @ApiQuery({ name: 'status', required: false, example: 'ACTIVE' })
  async getAchievements(
    @Query('category') category?: string,
    @Query('status') status?: string,
  ) {
    return this.achievementService.getAchievementDefinitions(category, status ?? 'ACTIVE');
  }

  @Get('categories/:category')
  @RequirePermissions('achievement.view')
  @ApiOperation({ summary: 'Get achievements by category' })
  async getByCategory(@Param('category') category: string) {
    return this.queryService.getAchievementsByCategory(category);
  }

  @Get(':idOrCode')
  @RequirePermissions('achievement.view')
  @ApiOperation({ summary: 'Get a single achievement definition by ID or code' })
  async getAchievement(@Param('idOrCode') idOrCode: string) {
    return this.achievementService.getAchievementDefinition(idOrCode);
  }

  @Patch(':id/status')
  @RequirePermissions('achievement.manage')
  @ApiOperation({ summary: 'Update achievement status (ACTIVE / INACTIVE / ARCHIVED)' })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateAchievementStatusDto,
    @CurrentUser() user: any,
  ) {
    return this.achievementService.updateAchievementStatus(id, dto.status, user?.id);
  }

  // ─── User Achievements ────────────────────────────────────────────────────

  @Get('users/:userId')
  @RequirePermissions('achievement.view')
  @ApiOperation({ summary: 'Get all achievements unlocked by a user' })
  async getUserAchievements(@Param('userId') userId: string) {
    return this.achievementService.getUserAchievements(userId);
  }

  @Post('manual-grant')
  @RequirePermissions('achievement.manage')
  @ApiOperation({ summary: 'Manually grant an achievement to a user' })
  async manualGrant(@Body() dto: ManualGrantAchievementDto, @CurrentUser() user: any) {
    return this.achievementService.manualGrant(dto.userId, dto.achievementId, user?.id);
  }

  // ─── Achievement Progress ─────────────────────────────────────────────────

  @Get('users/:userId/progress')
  @RequirePermissions('achievement.view')
  @ApiOperation({ summary: 'Get all achievement progress entries for a user' })
  async getUserProgress(@Param('userId') userId: string) {
    return this.progressService.getUserProgress(userId);
  }

  @Get('users/:userId/progress/summary')
  @RequirePermissions('achievement.view')
  @ApiOperation({ summary: 'Get completion rate summary for a user' })
  async getProgressSummary(@Param('userId') userId: string) {
    return this.progressService.getProgressSummary(userId);
  }

  // ─── Event Evaluation ────────────────────────────────────────────────────

  @Post('evaluate')
  @RequirePermissions('achievement.manage')
  @ApiOperation({
    summary: 'Evaluate a domain event against all active achievements',
    description:
      'Triggers the rule engine to increment progress and unlock achievements for a user event.',
  })
  async evaluateEvent(@Body() dto: EvaluateEventDto, @CurrentUser() user: any) {
    return this.evaluationService.evaluateEvent({ ...dto, actorId: user?.id });
  }

  // ─── Reward Claim ─────────────────────────────────────────────────────────

  @Post('users/:userId/rewards/claim')
  @RequirePermissions('achievement.manage')
  @ApiOperation({ summary: 'Claim the reward for an unlocked achievement' })
  async claimReward(
    @Param('userId') userId: string,
    @Body() dto: ClaimRewardDto,
    @CurrentUser() user: any,
  ) {
    return this.rewardService.claimRewardByAchievementId(userId, dto.achievementId, user?.id);
  }

  // ─── Badges ──────────────────────────────────────────────────────────────

  @Post('badges')
  @RequirePermissions('badge.manage')
  @ApiOperation({ summary: 'Create a new badge definition' })
  async createBadge(@Body() dto: CreateBadgeDto) {
    return this.badgeService.createBadge({
      ...dto,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    });
  }

  @Get('badges')
  @RequirePermissions('achievement.view')
  @ApiOperation({ summary: 'List badge definitions' })
  @ApiQuery({ name: 'tier', required: false })
  @ApiQuery({ name: 'badgeType', required: false })
  async getBadges(@Query('tier') tier?: string, @Query('badgeType') badgeType?: string) {
    return this.badgeService.getBadgeDefinitions(tier, badgeType);
  }

  @Get('badges/:code')
  @RequirePermissions('achievement.view')
  @ApiOperation({ summary: 'Get badge definition by code' })
  async getBadge(@Param('code') code: string) {
    return this.badgeService.getBadgeDefinition(code);
  }

  @Get('users/:userId/badges')
  @RequirePermissions('achievement.view')
  @ApiOperation({ summary: 'Get all badges in a user inventory' })
  async getUserBadges(@Param('userId') userId: string) {
    return this.badgeService.getUserBadges(userId);
  }

  @Get('users/:userId/badges/equipped')
  @RequirePermissions('achievement.view')
  @ApiOperation({ summary: 'Get the currently equipped badge for a user' })
  async getEquippedBadge(@Param('userId') userId: string) {
    return this.badgeService.getUserEquippedBadge(userId);
  }

  @Post('users/:userId/badges/equip')
  @RequirePermissions('achievement.view')
  @ApiOperation({ summary: 'Equip a badge from user inventory' })
  async equipBadge(
    @Param('userId') userId: string,
    @Body() dto: EquipBadgeDto,
    @CurrentUser() user: any,
  ) {
    return this.badgeService.equipBadge(userId, dto.badgeCode, user?.id);
  }

  @Post('users/:userId/badges/unequip')
  @RequirePermissions('achievement.view')
  @ApiOperation({ summary: 'Unequip a badge from user inventory' })
  async unequipBadge(
    @Param('userId') userId: string,
    @Body() dto: EquipBadgeDto,
    @CurrentUser() user: any,
  ) {
    return this.badgeService.unequipBadge(userId, dto.badgeCode, user?.id);
  }

  @Post('badges/admin-grant')
  @RequirePermissions('badge.manage')
  @ApiOperation({ summary: 'Admin-grant a badge directly to a user' })
  async adminGrantBadge(@Body() dto: AdminGrantBadgeDto, @CurrentUser() user: any) {
    return this.badgeService.adminGrantBadge(dto.userId, dto.badgeCode, user?.id);
  }

  // ─── Statistics ───────────────────────────────────────────────────────────

  @Get('statistics/platform')
  @RequirePermissions('achievement.statistics.view')
  @ApiOperation({ summary: 'Get platform-wide achievement statistics' })
  async getPlatformStatistics() {
    return this.statisticsService.getPlatformSummary();
  }

  @Get('statistics/progress-distribution')
  @RequirePermissions('achievement.statistics.view')
  @ApiOperation({ summary: 'Get progress distribution across achievements' })
  async getProgressDistribution() {
    return this.statisticsService.getProgressDistribution();
  }

  @Get('statistics/completion-rates')
  @RequirePermissions('achievement.statistics.view')
  @ApiOperation({ summary: 'Get completion rates for active achievements' })
  async getCompletionRates() {
    return this.queryService.getCompletionRates();
  }

  @Get('statistics/top-achievers')
  @RequirePermissions('achievement.statistics.view')
  @ApiOperation({ summary: 'Get users with most achievement unlocks' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  async getTopAchievers(@Query('limit') limit?: number) {
    return this.queryService.getTopAchievers(limit ? Number(limit) : 50);
  }

  @Get('statistics/most-earned')
  @RequirePermissions('achievement.statistics.view')
  @ApiOperation({ summary: 'Get most frequently earned achievements' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  async getMostEarned(@Query('limit') limit?: number) {
    return this.queryService.getMostEarnedAchievements(limit ? Number(limit) : 20);
  }

  @Get('statistics/rarest')
  @RequirePermissions('achievement.statistics.view')
  @ApiOperation({ summary: 'Get rarest achievements by unlock count' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  async getRarest(@Query('limit') limit?: number) {
    return this.queryService.getRarestAchievements(limit ? Number(limit) : 20);
  }

  // ─── History ──────────────────────────────────────────────────────────────

  @Get('users/:userId/history')
  @RequirePermissions('achievement.view')
  @ApiOperation({ summary: 'Get paginated achievement history for a user' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getUserHistory(
    @Param('userId') userId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.queryService.getUserAchievementHistory(
      userId,
      limit ? Number(limit) : 50,
      offset ? Number(offset) : 0,
    );
  }

  // ─── Audit ────────────────────────────────────────────────────────────────

  @Get('audit')
  @RequirePermissions('achievement.audit.view')
  @ApiOperation({ summary: 'Get operational audit logs for the achievement engine' })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getAuditLogs(
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.auditService.getAuditLogs(
      userId,
      action,
      limit ? Number(limit) : 50,
      offset ? Number(offset) : 0,
    );
  }

  // ─── Configuration ────────────────────────────────────────────────────────

  @Get('configuration')
  @RequirePermissions('achievement.configuration.manage')
  @ApiOperation({ summary: 'List all achievement engine configuration parameters' })
  async listConfiguration() {
    return this.configService.listConfigurations();
  }

  @Post('configuration')
  @RequirePermissions('achievement.configuration.manage')
  @ApiOperation({ summary: 'Set an achievement engine dynamic configuration parameter' })
  async setConfiguration(
    @Body() dto: UpdateAchievementConfigurationDto,
    @CurrentUser() user: any,
  ) {
    return this.configService.setConfiguration(dto.key, dto.value, user?.id);
  }
}
