import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
  AssignTaskToModeratorDto,
  ClaimTaskRewardDto,
  CreateMissionDto,
  CreateTaskDto,
  EvaluateTaskEventDto,
  UpdateTaskConfigurationDto,
  UpdateTaskDto,
  UpdateTaskStatusDto,
  UpdateAssignmentStatusDto,
  UpdateAssignmentProgressDto,
  VerifyBanTargetDto,
  ExecuteBanTaskDto,
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
import { ModeratorTaskAssignmentService } from '../services/moderator-task-assignment.service';

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
    private readonly moderatorAssignmentService: ModeratorTaskAssignmentService,
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
    return this.taskService.getTaskDefinitions(category, status);
  }

  @Post('seed-defaults')
  @RequirePermissions('task.manage')
  @ApiOperation({ summary: 'Seed or update all standard ecosystem event-driven tasks' })
  async seedDefaults() {
    return this.taskService.seedDefaultTasks();
  }

  @Get('missions')
  @RequirePermissions('task.view')
  @ApiOperation({ summary: 'List mission definitions with tasks' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'status', required: false, example: 'ACTIVE' })
  async getMissions(@Query('category') category?: string, @Query('status') status?: string) {
    return this.missionService.getMissions(category, status);
  }

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

  @Get('moderator/my-assignments')
  @RequirePermissions('task.view.assigned')
  @ApiOperation({ summary: 'Moderator fetches tasks assigned to them' })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE'] })
  async myAssignments(@CurrentUser() user: any, @Query('status') status?: string) {
    return this.moderatorAssignmentService.getModeratorAssignments(user.id, status);
  }

  @Get('workforce/assignments')
  @RequirePermissions('task.assignment.oversight')
  @ApiOperation({
    summary: 'Admin/Super Admin oversight of every official-to-moderator assignment',
    description:
      'Unrestricted roles see the whole platform; an Official sees only assignments held by moderators inside their geographic scope.',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE'] })
  async workforceAssignments(@CurrentUser() user: any, @Query('status') status?: string) {
    return this.moderatorAssignmentService.getOversightAssignments(user.id, status);
  }

  @Get('official/assignable-moderators')
  @RequirePermissions('task.assign.moderator')
  @ApiOperation({ summary: 'Moderators the current official may assign work to' })
  @ApiQuery({ name: 'search', required: false })
  async assignableModerators(@CurrentUser() user: any, @Query('search') search?: string) {
    return this.moderatorAssignmentService.getAssignableModerators(user.id, search);
  }

  @Get('official/lookup-user')
  @RequirePermissions('task.assign.moderator')
  @ApiOperation({
    summary: 'Resolve a ban target by user ID or username, within the Official scope',
  })
  @ApiQuery({ name: 'q', required: true, description: 'User ID (uuid) or exact username' })
  async lookupBanCandidate(@CurrentUser() user: any, @Query('q') q: string) {
    return this.moderatorAssignmentService.lookupBanCandidate(user.id, q ?? '');
  }

  @Get('official/assigned-by-me')
  @RequirePermissions('task.assign.moderator')
  @ApiOperation({ summary: 'Tasks the current official has assigned, with live moderator status' })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE'] })
  async assignedByMe(@CurrentUser() user: any, @Query('status') status?: string) {
    return this.moderatorAssignmentService.getAssignedBy(user.id, status);
  }

  @Get('moderator/my-assignments/summary')
  @RequirePermissions('task.view.assigned')
  @ApiOperation({
    summary: 'Dashboard task-completion summary — Assigned/Completed/Pending/Overdue + overdue %',
  })
  async myAssignmentSummary(@CurrentUser() user: any) {
    return this.queryService.moderatorAssignmentSummary(user.id);
  }

  @Post('moderator/assignments/:assignmentId/verify-target')
  @RequirePermissions('task.view.assigned')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Moderator verifies the user their BAN_USER task targets',
    description:
      'Rejects an id other than the one the Official pinned to the task, and refuses a user outside the moderator region. Both checks are server-side.',
  })
  async verifyBanTarget(
    @Param('assignmentId') assignmentId: string,
    @Body() dto: VerifyBanTargetDto,
    @CurrentUser() user: any,
  ) {
    return this.moderatorAssignmentService.resolveBanTarget(assignmentId, user.id, dto.userId);
  }

  @Post('moderator/assignments/:assignmentId/execute-ban')
  @RequirePermissions('task.view.assigned')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Moderator bans the task target, completing the task',
    description:
      'Delegates to the same PlatformBanService the in-room Individual Ban uses, then completes this assignment and notifies the assigning Official.',
  })
  async executeBanTask(
    @Param('assignmentId') assignmentId: string,
    @Body() dto: ExecuteBanTaskDto,
    @CurrentUser() user: any,
  ) {
    return this.moderatorAssignmentService.executeBanTask(
      assignmentId,
      user.id,
      dto.reason,
      dto.userId,
    );
  }

  @Patch('moderator/assignments/:assignmentId/progress')
  @RequirePermissions('task.view.assigned')
  @ApiOperation({
    summary: 'Moderator records progress against the target (e.g. 50 of 100)',
    description:
      'Progress is persisted on the shared assignment row, so the assigning Official sees the same number. Reaching the target completes the task and notifies the Official.',
  })
  async updateAssignmentProgress(
    @Param('assignmentId') assignmentId: string,
    @Body() dto: UpdateAssignmentProgressDto,
    @CurrentUser() user: any,
  ) {
    return this.moderatorAssignmentService.updateProgress(
      assignmentId,
      user.id,
      dto.currentProgress,
      dto.remarks,
    );
  }

  @Patch('moderator/assignments/:assignmentId')
  @RequirePermissions('task.view.assigned')
  @ApiOperation({ summary: 'Moderator updates assignment status (IN_PROGRESS / COMPLETED)' })
  async updateAssignmentStatus(
    @Param('assignmentId') assignmentId: string,
    @Body() dto: UpdateAssignmentStatusDto,
    @CurrentUser() user: any,
  ) {
    return this.moderatorAssignmentService.updateAssignmentStatus(
      assignmentId,
      user.id,
      dto.status,
    );
  }

  @Get('mobile/feed')
  @ApiOperation({ summary: 'Mobile: all active tasks + event missions with user progress overlay' })
  @ApiQuery({ name: 'userId', required: false })
  async getMobileFeed(@Query('userId') userId?: string, @CurrentUser('id') authUserId?: string) {
    return this.queryService.getMobileFeed(userId || authUserId);
  }

  @Post('me/rewards/claim')
  @ApiOperation({ summary: 'Self-scoped reward claim for regular users' })
  async selfClaim(@Body('taskId') taskId: string, @CurrentUser() user: any) {
    return this.queryService.selfClaimReward(user?.id, taskId);
  }

  @Get('categories/:category')
  @RequirePermissions('task.view')
  @ApiOperation({ summary: 'Get tasks by category' })
  async getByCategory(@Param('category') category: string) {
    return this.queryService.getTasksByCategory(category);
  }

  // ─── End-User Self-Service ───────────────────────────────────────────

  @Get('me')
  @ApiOperation({ summary: 'Get current user active tasks with progress overlay' })
  @ApiQuery({ name: 'category', required: false })
  async getMyActiveTasks(@CurrentUser('id') userId: string, @Query('category') category?: string) {
    return this.queryService.getUserActiveTasks(userId, category);
  }

  @Get('me/missions')
  @ApiOperation({ summary: 'Get current user mission progress records' })
  async getMyMissions(@CurrentUser('id') userId: string) {
    return this.missionProgressService.getUserMissionProgress(userId);
  }

  @Post('me/claim/:taskId')
  @ApiOperation({ summary: 'Claim reward for a completed task' })
  async claimMyTaskReward(@Param('taskId') taskId: string, @CurrentUser('id') userId: string) {
    return this.rewardService.dispatchReward(userId, taskId, undefined, undefined, userId);
  }

  @Post('me/missions/claim/:missionId')
  @ApiOperation({ summary: 'Claim reward for a completed mission' })
  async claimMyMissionReward(
    @Param('missionId') missionId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.rewardService.dispatchReward(userId, undefined, missionId, undefined, userId);
  }

  @Get('missions/:idOrCode')
  @RequirePermissions('task.view')
  @ApiOperation({ summary: 'Get mission by ID or code' })
  async getMission(@Param('idOrCode') idOrCode: string) {
    return this.missionService.getMission(idOrCode);
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

  // ─── Wildcard Routes (:idOrCode, :id) ──────────────────────────────────

  @Get(':idOrCode')
  @RequirePermissions('task.view')
  @ApiOperation({ summary: 'Get task by ID or code' })
  async getTask(@Param('idOrCode') idOrCode: string) {
    return this.taskService.getTaskDefinition(idOrCode);
  }

  @Patch(':id')
  @RequirePermissions('task.manage')
  @ApiOperation({ summary: 'Update task definition parameters, event triggers, or rewards' })
  async updateTask(@Param('id') id: string, @Body() dto: UpdateTaskDto, @CurrentUser() user: any) {
    return this.taskService.updateTask(id, { ...dto, actorId: user?.id });
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

  @Post(':id/assign-moderator/:moderatorId')
  @RequirePermissions('task.assign.moderator')
  @ApiOperation({ summary: 'Official or Manager assigns a task to a moderator' })
  async assignToModerator(
    @Param('id') taskId: string,
    @Param('moderatorId') moderatorId: string,
    @Body() dto: AssignTaskToModeratorDto,
    @CurrentUser() user: any,
  ) {
    return this.moderatorAssignmentService.assignTask({
      taskId,
      moderatorId,
      assignedBy: user.id,
      startDate: dto.startDate ? new Date(dto.startDate) : undefined,
      dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined,
      targetCount: dto.targetCount,
      priority: dto.priority,
      taskType: dto.taskType,
      targetUserId: dto.targetUserId,
      targetUserIds: dto.targetUserIds,
      banReason: dto.banReason,
      notes: dto.notes,
    });
  }

  // ─── Evaluation Engine & Rewards Claim ─────────────────────────────────

  @Post('evaluate')
  @RequirePermissions('task.manage')
  @ApiOperation({
    summary: 'Evaluate a domain event against all active task definitions',
    description: 'Triggers the rule engine to increment task/mission progress for a user event.',
  })
  async evaluateEvent(@Body() dto: EvaluateTaskEventDto, @CurrentUser() user: any) {
    return this.evaluationService.evaluateEvent({ ...dto, actorId: user?.id });
  }

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
}
