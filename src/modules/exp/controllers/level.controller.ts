import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { PermissionsGuard } from 'src/common/guards/permission.guard';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import {
  AddExpDto,
  RemoveExpDto,
  UpdateLevelConfigurationDto,
  UpsertLevelDefinitionDto,
} from '../dto/level.dto';
import { ExperienceHistoryService } from '../services/experience-history.service';
import { ExperienceSourceService } from '../services/experience-source.service';
import { ExperienceService } from '../services/experience.service';
import { LevelAuditService } from '../services/level-audit.service';
import { LevelConfigurationService } from '../services/level-configuration.service';
import { LevelQueryService } from '../services/level-query.service';
import { LevelService } from '../services/level.service';
import { LevelStatisticsService } from '../services/level-statistics.service';

@ApiTags('Enterprise Level & Experience Engine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditLogInterceptor)
@Controller('levels')
export class LevelController {
  constructor(
    private readonly levelService: LevelService,
    private readonly experienceService: ExperienceService,
    private readonly historyService: ExperienceHistoryService,
    private readonly sourceService: ExperienceSourceService,
    private readonly configService: LevelConfigurationService,
    private readonly statisticsService: LevelStatisticsService,
    private readonly auditService: LevelAuditService,
    private readonly queryService: LevelQueryService,
  ) {}

  @Get('users/:userId')
  @RequirePermissions('level.view')
  @ApiOperation({ summary: 'Get user level, progress percentage, and thresholds' })
  @ApiResponse({ status: 200, description: 'User level and experience details' })
  async getUserLevel(@Param('userId') userId: string) {
    return this.levelService.getUserLevel(userId);
  }

  @Post('exp/add')
  @RequirePermissions('level.manage')
  @ApiOperation({ summary: 'Award EXP to user with exact-once idempotency protection' })
  @ApiResponse({ status: 201, description: 'EXP awarded and level updated' })
  async addExp(@Body() dto: AddExpDto, @CurrentUser() user: any) {
    return this.experienceService.addExp({
      ...dto,
      actorId: user?.id,
    });
  }

  @Post('exp/remove')
  @RequirePermissions('level.manage')
  @ApiOperation({ summary: 'Deduct EXP from user' })
  @ApiResponse({ status: 200, description: 'EXP deducted and level recalculated' })
  async removeExp(@Body() dto: RemoveExpDto, @CurrentUser() user: any) {
    return this.experienceService.removeExp({
      ...dto,
      actorId: user?.id,
    });
  }

  @Post('users/:userId/recalculate')
  @RequirePermissions('level.manage')
  @ApiOperation({ summary: 'Recalculate user level from cumulative EXP' })
  async recalculate(@Param('userId') userId: string, @CurrentUser() user: any) {
    return this.levelService.recalculateUserLevel(userId, user?.id);
  }

  @Get('definitions')
  @RequirePermissions('level.view')
  @ApiOperation({ summary: 'Get level definition threshold ladder' })
  async getDefinitions() {
    return this.levelService.getLevelDefinitions();
  }

  @Put('definitions')
  @RequirePermissions('level.configuration.manage')
  @ApiOperation({ summary: 'Create or update level definition threshold' })
  async upsertDefinition(@Body() dto: UpsertLevelDefinitionDto, @CurrentUser() user: any) {
    return this.levelService.upsertLevelDefinition(
      {
        ...dto,
        requiredExp: BigInt(dto.requiredExp),
      },
      user?.id,
    );
  }

  @Get('sources')
  @RequirePermissions('level.view')
  @ApiOperation({ summary: 'Get active EXP sources' })
  async getSources() {
    return this.sourceService.getActiveSources();
  }

  @Get('users/:userId/history')
  @RequirePermissions('level.view')
  @ApiOperation({ summary: 'Get paginated EXP transaction history for user' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getHistory(
    @Param('userId') userId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.historyService.getUserHistory(
      userId,
      limit ? Number(limit) : 20,
      offset ? Number(offset) : 0,
    );
  }

  @Get('statistics')
  @RequirePermissions('level.statistics.view')
  @ApiOperation({ summary: 'Get pre-aggregated level and progression statistics' })
  async getStatistics() {
    return this.statisticsService.getSummaryStatistics();
  }

  @Get('audit')
  @RequirePermissions('level.audit.view')
  @ApiOperation({ summary: 'Get operational audit logs for level engine events' })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getAuditLogs(
    @Query('userId') userId?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.auditService.getAuditLogs(
      userId,
      limit ? Number(limit) : 50,
      offset ? Number(offset) : 0,
    );
  }

  @Get('leaderboard')
  @RequirePermissions('level.view')
  @ApiOperation({ summary: 'Get top users by level and lifetime EXP' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  async getLeaderboard(@Query('limit') limit?: number) {
    return this.queryService.getTopUsers(limit ? Number(limit) : 50);
  }

  @Get('distribution')
  @RequirePermissions('level.view')
  @ApiOperation({ summary: 'Get user count distribution per level' })
  async getDistribution() {
    return this.queryService.getLevelDistribution();
  }

  @Put('configuration')
  @RequirePermissions('level.configuration.manage')
  @ApiOperation({ summary: 'Update level engine dynamic configuration parameter' })
  async updateConfiguration(@Body() dto: UpdateLevelConfigurationDto, @CurrentUser() user: any) {
    return this.configService.setConfiguration(dto.key, dto.value, user?.id);
  }
}
