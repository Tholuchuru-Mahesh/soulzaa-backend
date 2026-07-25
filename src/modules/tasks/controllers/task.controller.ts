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
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import {
  ClaimTaskRewardDto,
  CreateMissionDto,
  CreateTaskDto,
  EvaluateTaskEventDto,
  UpdateTaskConfigurationDto,
  UpdateTaskStatusDto,
} from '../dto/task.dto';
import { MissionProgressService } from '../services/mission-progress.service';
import { MissionService } from '../services/mission.service';
import { TaskAuditService } from '../services/task-audit.service';
import { TaskConfigurationService } from '../services/task-configuration.service';
import { TaskEvaluationService } from '../services/task-evaluation.service';
import { TaskProgressService } from '../services/task-progress.service';
import { TaskQueryService } from '../services/task-query.service';
import { TaskRewardService } from '../services/task-reward.service';
import { TaskService } from '../services/task.service';
import { TaskStatisticsService } from '../services/task-statistics.service';

@ApiTags('Enterprise Tasks & Missions Engine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@UseInterceptors(AuditLogInterceptor)
@Controller('tasks')
export class TaskController {
  constructor(
    private readonly taskService: TaskService,
    private readonly missionService: MissionService,
    private readonly progressService: TaskProgressService,
    private readonly missionProgressService: MissionProgressService,
    private readonly evaluationService: TaskEvaluationService,
    private readonly rewardService: TaskRewardService,
    private readonly statisticsService: TaskStatisticsService,
    private readonly auditService: TaskAuditService,
    private readonly queryService: TaskQueryService,
    private readonly configService: TaskConfigurationService,
  ) {}

  // ─── Task & Mission Definitions ───────────────────────────────────────

  @Post()
  @RequirePermissions('task.manage')
  @ApiOperation({ summary: 'Create a new task definition' })
  @ApiResponse({ status: 201, description: 'Task definition created' })
  async createTask(@Body() dto: CreateTaskDto, @CurrentUser() user: any) {
    return this.taskService.createTask({
      ...dto,
      startTime: dto.startTime ? new Date(dto.startTime) : undefined,
      endTime: dto.endTime ? new Date(dto.endTime) : undefined,
      actorId: user?.id,
    });
  }

  @Post('missions')
  @RequirePermissions('task.manage')
  @ApiOperation({ summary: 'Create a new mission definition' })
  async createMission(@Body() dto: CreateMissionDto, @CurrentUser() user: any) {
    return this.missionService.createMission({ ...dto, actorId: user?.id });
  }

  @Get()
  @RequirePermissions('task.view')
  @ApiOperation({ summary: 'List active task definitions' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'status', required: false, example: 'ACTIVE' })
  async getTasks(@Query('category') category?: string, @Query('status') status?: string) {
    return this.taskService.getTaskDefinitions(category, status ?? 'ACTIVE');
  }

  @Get('missions')
  @RequirePermissions('task.view')
  @ApiOperation({ summary: 'List mission definitions with tasks' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'status', required: false, example: 'ACTIVE' })
  async getMissions(@Query('category') category?: string, @Query('status') status?: string) {
    return this.missionService.getMissions(category, status ?? 'ACTIVE');
  }

  @Get('categories/:category')
  @RequirePermissions('task.view')
  @ApiOperation({ summary: 'Get tasks by category' })
  async getByCategory(@Param('category') category: string) {
    return this.queryService.getTasksByCategory(category);
  }

  @Get('missions/:idOrCode')
  @RequirePermissions('task.view')
  @ApiOperation({ summary: 'Get mission by ID or code' })
  async getMission(@Param('idOrCode') idOrCode: string) {
    return this.missionService.getMission(idOrCode);
  }

  @Get(':idOrCode')
  @RequirePermissions('task.view')
  @ApiOperation({ summary: 'Get task by ID or code' })
  async getTask(@Param('idOrCode') idOrCode: string) {
    return this.taskService.getTaskDefinition(idOrCode);
  }

  @Patch(':id/status')
  @RequirePermissions('task.manage')
  @ApiOperation({ summary: 'Update task status' })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateTaskStatusDto,
    @CurrentUser() user: any,
  ) {
    return this.taskService.updateTaskStatus(id, dto.status, user?.id);
  }

  // ─── Evaluation Engine ────────────────────────────────────────────────

  @Post('evaluate')
  @RequirePermissions('task.manage')
  @ApiOperation({
    summary: 'Evaluate a domain event against all active task definitions',
    description: 'Triggers the rule engine to increment task/mission progress for a user event.',
  })
  async evaluateEvent(@Body() dto: EvaluateTaskEventDto, @CurrentUser() user: any) {
    return this.evaluationService.evaluateEvent({ ...dto, actorId: user?.id });
  }

  // ─── Rewards ──────────────────────────────────────────────────────────

  @Post('users/:userId/rewards/claim')
  @RequirePermissions('task.manage')
  @ApiOperation({ summary: 'Claim / dispatch reward for a completed task or mission' })
  async claimReward(
    @Param('userId') userId: string,
    @Body() dto: ClaimTaskRewardDto,
    @CurrentUser() user: any,
  ) {
    return this.rewardService.dispatchReward(
      userId,
      dto.taskId,
      dto.missionId,
      undefined,
      user?.id,
    );
  }

  // ─── User Progress & History ──────────────────────────────────────────

  @Get('users/:userId/active')
  @RequirePermissions('task.view')
  @ApiOperation({ summary: 'Get active tasks for user with progress overlay' })
  @ApiQuery({ name: 'category', required: false })
  async getUserActiveTasks(@Param('userId') userId: string, @Query('category') category?: string) {
    return this.queryService.getUserActiveTasks(userId, category);
  }

  @Get('users/:userId/progress')
  @RequirePermissions('task.view')
  @ApiOperation({ summary: 'Get raw task progress records for user' })
  async getUserProgress(@Param('userId') userId: string) {
    return this.progressService.getUserProgress(userId);
  }

  @Get('users/:userId/missions/progress')
  @RequirePermissions('task.view')
  @ApiOperation({ summary: 'Get raw mission progress records for user' })
  async getUserMissionProgress(@Param('userId') userId: string) {
    return this.missionProgressService.getUserMissionProgress(userId);
  }

  @Get('users/:userId/history')
  @RequirePermissions('task.view')
  @ApiOperation({ summary: 'Get task history logs for user' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getUserHistory(
    @Param('userId') userId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.queryService.getUserTaskHistory(
      userId,
      limit ? Number(limit) : 50,
      offset ? Number(offset) : 0,
    );
  }

  // ─── Statistics ────────────────────────────────────────────────────────

  @Get('statistics/platform')
  @RequirePermissions('task.statistics.view')
  @ApiOperation({ summary: 'Get platform-wide task & mission statistics' })
  async getPlatformStatistics() {
    return this.statisticsService.getPlatformSummary();
  }

  @Get('statistics/categories/:category')
  @RequirePermissions('task.statistics.view')
  @ApiOperation({ summary: 'Get statistics for a specific task category' })
  async getCategoryStatistics(@Param('category') category: string) {
    return this.statisticsService.getCategoryStatistics(category);
  }

  // ─── Audit ────────────────────────────────────────────────────────────

  @Get('audit')
  @RequirePermissions('task.audit.view')
  @ApiOperation({ summary: 'Get operational audit logs for the tasks engine' })
  @ApiQuery({ name: 'taskId', required: false })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getAuditLogs(
    @Query('taskId') taskId?: string,
    @Query('action') action?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.auditService.getLogs(
      taskId,
      action,
      limit ? Number(limit) : 50,
      offset ? Number(offset) : 0,
    );
  }

  // ─── Configuration ────────────────────────────────────────────────────

  @Get('configuration')
  @RequirePermissions('task.configuration.manage')
  @ApiOperation({ summary: 'List all task engine configuration parameters' })
  async listConfiguration() {
    return this.configService.listConfigurations();
  }

  @Post('configuration')
  @RequirePermissions('task.configuration.manage')
  @ApiOperation({ summary: 'Set dynamic task engine configuration parameter' })
  async setConfiguration(@Body() dto: UpdateTaskConfigurationDto, @CurrentUser() user: any) {
    return this.configService.setConfiguration(dto.key, dto.value, user?.id);
  }
}
