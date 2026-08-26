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
  CreateEventDto,
  DispatchRewardDto,
  DisqualifyParticipantDto,
  RegisterEventDto,
  UpdateEventConfigurationDto,
  UpdateEventDto,
  UpdateEventStatusDto,
  UpdateParticipantScoreDto,
} from '../dto/event.dto';
import { EventAuditService } from '../services/event-audit.service';
import { EventConfigurationService } from '../services/event-configuration.service';
import { EventEligibilityService } from '../services/event-eligibility.service';
import { EventParticipationService } from '../services/event-participation.service';
import { EventQueryService } from '../services/event-query.service';
import { EventRegistrationService } from '../services/event-registration.service';
import { EventRewardService } from '../services/event-reward.service';
import { EventSchedulerService } from '../services/event-scheduler.service';
import { EventService } from '../services/event.service';
import { EventStatisticsService } from '../services/event-statistics.service';

@ApiTags('Enterprise Events Engine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@UseInterceptors(AuditLogInterceptor)
@Controller('enterprise-events')
export class EnterpriseEventController {
  constructor(
    private readonly eventService: EventService,
    private readonly registrationService: EventRegistrationService,
    private readonly participationService: EventParticipationService,
    private readonly eligibilityService: EventEligibilityService,
    private readonly rewardService: EventRewardService,
    private readonly schedulerService: EventSchedulerService,
    private readonly statisticsService: EventStatisticsService,
    private readonly auditService: EventAuditService,
    private readonly queryService: EventQueryService,
    private readonly configService: EventConfigurationService,
  ) {}

  // ─── Event Definitions ──────────────────────────────────────────────

  @Post()
  @RequirePermissions('event.create')
  @ApiOperation({ summary: 'Create a new event definition' })
  @ApiResponse({ status: 201, description: 'Event definition created' })
  async createEvent(@Body() dto: CreateEventDto, @CurrentUser() user: any) {
    return this.eventService.createEvent({
      ...dto,
      startTime: new Date(dto.startTime),
      endTime: new Date(dto.endTime),
      regStartTime: dto.regStartTime ? new Date(dto.regStartTime) : undefined,
      regEndTime: dto.regEndTime ? new Date(dto.regEndTime) : undefined,
      actorId: user?.id,
    });
  }

  @Get('admin/all')
  @RequirePermissions('event.manage')
  @ApiOperation({ summary: 'Admin: List ALL event definitions regardless of status' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'status', required: false })
  async getAllEventsAdmin(@Query('category') category?: string, @Query('status') status?: string) {
    return this.eventService.getAllEventDefinitions(category, status);
  }

  @Get()
  @RequirePermissions('event.view')
  @ApiOperation({ summary: 'List active/approved event definitions (user-facing)' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'status', required: false })
  async getEvents(@Query('category') category?: string, @Query('status') status?: string) {
    return this.eventService.getEventDefinitions(category, status);
  }

  @Get('schedules')
  @RequirePermissions('event.view')
  @ApiOperation({ summary: 'Get active & upcoming event schedules' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  async getSchedules(@Query('category') category?: string, @Query('limit') limit?: number) {
    return this.queryService.getEventSchedules(category, limit ? Number(limit) : 50);
  }

  @Get('categories/:category')
  @RequirePermissions('event.view')
  @ApiOperation({ summary: 'Get events by category' })
  async getByCategory(@Param('category') category: string) {
    return this.queryService.getEventsByCategory(category);
  }

  @Get('mobile/active-events')
  @ApiOperation({
    summary: 'Mobile: currently live events in scope for the caller (no staff permission required)',
  })
  async getActiveEventsForMe(@CurrentUser('id') userId: string) {
    return this.eventService.getActiveEventsForUser(userId);
  }

  @Get(':idOrCode')
  @RequirePermissions('event.view')
  @ApiOperation({ summary: 'Get a single event definition by ID or code' })
  async getEvent(@Param('idOrCode') idOrCode: string) {
    return this.eventService.getEventDefinition(idOrCode);
  }

  @Patch(':id')
  @RequirePermissions('event.create')
  @ApiOperation({ summary: 'Update an event definition' })
  async updateEvent(
    @Param('id') id: string,
    @Body() dto: UpdateEventDto,
    @CurrentUser() user: any,
  ) {
    return this.eventService.updateEvent(id, {
      ...dto,
      startTime: dto.startTime ? new Date(dto.startTime) : undefined,
      endTime: dto.endTime ? new Date(dto.endTime) : undefined,
      regStartTime: dto.regStartTime ? new Date(dto.regStartTime) : undefined,
      regEndTime: dto.regEndTime ? new Date(dto.regEndTime) : undefined,
      actorId: user?.id,
    });
  }

  @Patch(':id/status')
  @RequirePermissions('event.create')
  @ApiOperation({ summary: 'Update event lifecycle status' })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateEventStatusDto,
    @CurrentUser() user: any,
  ) {
    return this.eventService.updateStatus(id, dto.status, user?.id);
  }

  @Post(':id/cancel')
  @RequirePermissions('event.manage')
  @ApiOperation({ summary: 'Cancel an event' })
  async cancelEvent(
    @Param('id') id: string,
    @Body('reason') reason?: string,
    @CurrentUser() user?: any,
  ) {
    return this.eventService.cancelEvent(id, reason, user?.id);
  }

  // ─── Registration ───────────────────────────────────────────────────

  @Post(':id/register')
  @RequirePermissions('event.view')
  @ApiOperation({ summary: 'Register a user for an event' })
  async register(
    @Param('id') eventId: string,
    @Body() dto: RegisterEventDto,
    @CurrentUser() user: any,
  ) {
    return this.registrationService.registerUser(eventId, dto.userId, user?.id);
  }

  @Post(':id/unregister')
  @RequirePermissions('event.view')
  @ApiOperation({ summary: 'Unregister a user from an event' })
  async unregister(
    @Param('id') eventId: string,
    @Body() dto: RegisterEventDto,
    @CurrentUser() user: any,
  ) {
    return this.registrationService.unregisterUser(eventId, dto.userId, user?.id);
  }

  @Get(':id/registrations')
  @RequirePermissions('event.view')
  @ApiOperation({ summary: 'Get registrations for an event' })
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getRegistrations(
    @Param('id') eventId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.registrationService.getEventRegistrations(
      eventId,
      limit ? Number(limit) : 100,
      offset ? Number(offset) : 0,
    );
  }

  @Get(':id/eligibility/:userId')
  @RequirePermissions('event.view')
  @ApiOperation({ summary: 'Check user eligibility for an event' })
  async checkEligibility(@Param('id') eventId: string, @Param('userId') userId: string) {
    return this.eligibilityService.checkEligibility(userId, eventId);
  }

  // ─── Participation ──────────────────────────────────────────────────

  @Post(':id/join')
  @RequirePermissions('event.view')
  @ApiOperation({ summary: 'Join / check in to an event as a participant' })
  async joinEvent(
    @Param('id') eventId: string,
    @Body() dto: RegisterEventDto,
    @CurrentUser() user: any,
  ) {
    return this.participationService.joinEvent(eventId, dto.userId, user?.id);
  }

  @Post(':id/score')
  @RequirePermissions('event.manage')
  @ApiOperation({ summary: 'Update participant score in an event' })
  async updateScore(@Param('id') eventId: string, @Body() dto: UpdateParticipantScoreDto) {
    return this.participationService.updateParticipantScore(eventId, dto.userId, dto.scoreDelta);
  }

  @Post(':id/complete-participant')
  @RequirePermissions('event.manage')
  @ApiOperation({ summary: 'Mark participant as completed' })
  async completeParticipant(
    @Param('id') eventId: string,
    @Body() dto: RegisterEventDto,
    @CurrentUser() user: any,
  ) {
    return this.participationService.completeParticipation(eventId, dto.userId, user?.id);
  }

  @Post(':id/disqualify')
  @RequirePermissions('event.manage')
  @ApiOperation({ summary: 'Disqualify a participant from an event' })
  async disqualify(
    @Param('id') eventId: string,
    @Body() dto: DisqualifyParticipantDto,
    @CurrentUser() user: any,
  ) {
    return this.participationService.disqualifyParticipant(
      eventId,
      dto.userId,
      dto.reason,
      user?.id,
    );
  }

  @Get(':id/participants')
  @RequirePermissions('event.view')
  @ApiOperation({ summary: 'Get participants for an event' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getParticipants(
    @Param('id') eventId: string,
    @Query('status') status?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.participationService.getEventParticipants(
      eventId,
      status,
      limit ? Number(limit) : 100,
      offset ? Number(offset) : 0,
    );
  }

  // ─── Rewards ────────────────────────────────────────────────────────

  @Post(':id/rewards/dispatch')
  @RequirePermissions('event.manage')
  @ApiOperation({ summary: 'Dispatch reward definition to a participant' })
  async dispatchReward(
    @Param('id') eventId: string,
    @Body() dto: DispatchRewardDto,
    @CurrentUser() user: any,
  ) {
    return this.rewardService.dispatchReward(eventId, dto.userId, dto.customReward, user?.id);
  }

  @Post(':id/rewards/dispatch-all')
  @RequirePermissions('event.manage')
  @ApiOperation({ summary: 'Dispatch rewards to all completed participants' })
  async dispatchAllRewards(@Param('id') eventId: string, @CurrentUser() user: any) {
    return this.rewardService.dispatchAllParticipantRewards(eventId, user?.id);
  }

  // ─── Scheduler ──────────────────────────────────────────────────────

  @Post('scheduler/process')
  @RequirePermissions('event.manage')
  @ApiOperation({ summary: 'Trigger automatic event lifecycle status processing' })
  async processScheduler(@CurrentUser() user: any) {
    return this.schedulerService.processEventSchedules(user?.id);
  }

  // ─── User History & Statistics ──────────────────────────────────────

  @Get('users/:userId/registrations')
  @RequirePermissions('event.view')
  @ApiOperation({ summary: 'Get active event registrations for a user' })
  async getUserRegistrations(@Param('userId') userId: string) {
    return this.registrationService.getUserRegistrations(userId);
  }

  @Get('users/:userId/history')
  @RequirePermissions('event.view')
  @ApiOperation({ summary: 'Get user participation history' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getUserHistory(
    @Param('userId') userId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.queryService.getUserEventHistory(
      userId,
      limit ? Number(limit) : 50,
      offset ? Number(offset) : 0,
    );
  }

  @Get('statistics/platform')
  @RequirePermissions('event.statistics.view')
  @ApiOperation({ summary: 'Get platform-wide event statistics' })
  async getPlatformStatistics() {
    return this.statisticsService.getPlatformSummary();
  }

  @Get('statistics/categories/:category')
  @RequirePermissions('event.statistics.view')
  @ApiOperation({ summary: 'Get statistics for a specific event category' })
  async getCategoryStatistics(@Param('category') category: string) {
    return this.statisticsService.getCategoryStatistics(category);
  }

  @Get(':id/history')
  @RequirePermissions('event.view')
  @ApiOperation({ summary: 'Get event history log' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getEventHistoryLogs(
    @Param('id') eventId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.queryService.getEventHistoryLogs(
      eventId,
      limit ? Number(limit) : 50,
      offset ? Number(offset) : 0,
    );
  }

  // ─── Audit ──────────────────────────────────────────────────────────

  @Get('audit')
  @RequirePermissions('event.audit.view')
  @ApiOperation({ summary: 'Get operational audit logs for the events engine' })
  @ApiQuery({ name: 'eventId', required: false })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getAuditLogs(
    @Query('eventId') eventId?: string,
    @Query('action') action?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.auditService.getLogs(
      eventId,
      action,
      limit ? Number(limit) : 50,
      offset ? Number(offset) : 0,
    );
  }

  // ─── Configuration ──────────────────────────────────────────────────

  @Get('configuration')
  @RequirePermissions('event.configuration.manage')
  @ApiOperation({ summary: 'List all event engine configuration parameters' })
  async listConfiguration() {
    return this.configService.listConfigurations();
  }

  @Post('configuration')
  @RequirePermissions('event.configuration.manage')
  @ApiOperation({ summary: 'Set dynamic event engine configuration parameter' })
  async setConfiguration(@Body() dto: UpdateEventConfigurationDto, @CurrentUser() user: any) {
    return this.configService.setConfiguration(dto.key, dto.value, user?.id);
  }
}
