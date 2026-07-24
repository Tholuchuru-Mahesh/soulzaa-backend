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
import { NotificationCenterService } from '../services/notification-center.service';
import { NotificationInboxService } from '../services/notification-inbox.service';
import { NotificationPreferenceService } from '../services/notification-preference.service';
import { NotificationTemplateService } from '../services/notification-template.service';
import { NotificationStatisticsService } from '../services/notification-statistics.service';
import { NotificationAuditService } from '../services/notification-audit.service';
import { NotificationConfigurationService } from '../services/notification-configuration.service';
import { NotificationQueryService } from '../services/notification-query.service';
import {
  SendNotificationDto,
  CreateTemplateDto,
  UpdatePreferenceDto,
  UpdateConfigDto,
} from '../dto/notification-center.dto';

@ApiTags('Notification Center')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('notification-center')
export class NotificationCenterController {
  constructor(
    private readonly notificationCenterService: NotificationCenterService,
    private readonly inboxService: NotificationInboxService,
    private readonly preferenceService: NotificationPreferenceService,
    private readonly templateService: NotificationTemplateService,
    private readonly statisticsService: NotificationStatisticsService,
    private readonly auditService: NotificationAuditService,
    private readonly configService: NotificationConfigurationService,
    private readonly queryService: NotificationQueryService,
  ) {}

  // ── Dispatch & Send ────────────────────────────────────────────────
  @Post('send')
  @RequirePermissions('notification.manage')
  @ApiOperation({ summary: 'Create and dispatch a targeted/scheduled notification' })
  @ApiResponse({ status: 201, description: 'Notification queued or dispatched successfully.' })
  async send(@Body() dto: SendNotificationDto) {
    return this.notificationCenterService.send({
      recipientId: dto.recipientId,
      type: dto.type,
      templateCode: dto.templateCode,
      variables: dto.variables,
      priority: dto.priority,
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
      channels: dto.channels,
    });
  }

  @Post('broadcast')
  @RequirePermissions('announcement.manage')
  @ApiOperation({ summary: 'Broadcast a global announcement to all users' })
  async broadcast(
    @Query('templateCode') templateCode: string,
    @Body() variables: Record<string, string>,
  ) {
    return this.notificationCenterService.broadcastAnnouncement(templateCode, variables);
  }

  @Delete(':id/cancel')
  @RequirePermissions('notification.manage')
  @ApiOperation({ summary: 'Cancel a pending scheduled notification' })
  async cancel(@Param('id', ParseUUIDPipe) id: string) {
    await this.notificationCenterService.cancel(id);
    return { message: 'Notification successfully cancelled.' };
  }

  // ── User Inbox ─────────────────────────────────────────────────────
  @Get('inbox/:recipientId')
  @RequirePermissions('notification.view')
  @ApiOperation({ summary: 'Get user in-app notification inbox' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async getInbox(
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
  ) {
    return this.inboxService.getInbox(recipientId, parseInt(page), parseInt(limit));
  }

  @Patch('inbox/:id/read')
  @RequirePermissions('notification.manage')
  @ApiOperation({ summary: 'Mark an inbox notification item as read' })
  async markRead(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('recipientId', ParseUUIDPipe) recipientId: string,
  ) {
    return this.inboxService.markAsRead(id, recipientId);
  }

  @Delete('inbox/:id')
  @RequirePermissions('notification.manage')
  @ApiOperation({ summary: 'Soft delete an inbox notification item' })
  async deleteInboxItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('recipientId', ParseUUIDPipe) recipientId: string,
  ) {
    return this.inboxService.softDelete(id, recipientId);
  }

  @Get('inbox/:recipientId/unread-count')
  @RequirePermissions('notification.view')
  @ApiOperation({ summary: 'Get unread notification count for user' })
  async getUnreadCount(@Param('recipientId', ParseUUIDPipe) recipientId: string) {
    return { unreadCount: await this.inboxService.getUnreadCount(recipientId) };
  }

  // ── Templates ──────────────────────────────────────────────────────
  @Post('templates')
  @RequirePermissions('notification.manage')
  @ApiOperation({ summary: 'Create a notification template' })
  async createTemplate(@Body() dto: CreateTemplateDto) {
    return this.templateService.create(dto);
  }

  @Get('templates')
  @RequirePermissions('notification.view')
  @ApiOperation({ summary: 'Get list of templates' })
  @ApiQuery({ name: 'skip', required: false })
  @ApiQuery({ name: 'take', required: false })
  async getTemplates(
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    return this.queryService.getTemplates(parseInt(skip), parseInt(take));
  }

  // ── Preferences ────────────────────────────────────────────────────
  @Patch('preferences')
  @RequirePermissions('notification.manage')
  @ApiOperation({ summary: 'Set user channel delivery preference' })
  async setPreference(@Body() dto: UpdatePreferenceDto) {
    return this.preferenceService.set(dto);
  }

  @Get('preferences/:userId')
  @RequirePermissions('notification.view')
  @ApiOperation({ summary: 'Get user notification channel preferences' })
  async getPreferences(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.preferenceService.getPreferences(userId);
  }

  // ── Query Details ──────────────────────────────────────────────────
  @Get(':id')
  @RequirePermissions('notification.view')
  @ApiOperation({ summary: 'Get notification details, inboxes and delivery logs' })
  async getDetails(@Param('id', ParseUUIDPipe) id: string) {
    return this.queryService.getNotificationDetails(id);
  }

  @Get('recipient/:recipientId/history')
  @RequirePermissions('notification.view')
  @ApiOperation({ summary: 'Get recipient notification history' })
  async getHistory(
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    return this.queryService.getRecipientHistory(recipientId, parseInt(skip), parseInt(take));
  }

  // ── Statistics ─────────────────────────────────────────────────────
  @Get('statistics/summary')
  @RequirePermissions('notification.statistics.view')
  @ApiOperation({ summary: 'Get statistics summary for period' })
  @ApiQuery({ name: 'period', required: true })
  @ApiQuery({ name: 'dateKey', required: true })
  async getStatsSummary(
    @Query('period') period: string,
    @Query('dateKey') dateKey: string,
  ) {
    return this.statisticsService.getSummary(period, dateKey);
  }

  @Get('statistics/rates')
  @RequirePermissions('notification.statistics.view')
  @ApiOperation({ summary: 'Get global read, delivery, and failure rates' })
  async getStatsRates() {
    return this.statisticsService.getGlobalRates();
  }

  @Get('statistics/channels')
  @RequirePermissions('notification.statistics.view')
  @ApiOperation({ summary: 'Get statistics channel usage breakdown' })
  async getStatsChannels() {
    return this.statisticsService.getChannelUsageBreakdown();
  }

  @Get('statistics/templates')
  @RequirePermissions('notification.statistics.view')
  @ApiOperation({ summary: 'Get statistics template usage breakdown' })
  async getStatsTemplates() {
    return this.statisticsService.getTemplateUsageBreakdown();
  }

  // ── Audit ──────────────────────────────────────────────────────────
  @Get('audit/all')
  @RequirePermissions('notification.audit.view')
  @ApiOperation({ summary: 'List all operational audit logs' })
  async getAudit(
    @Query('skip') skip = '0',
    @Query('take') take = '100',
  ) {
    return this.auditService.findAll(parseInt(skip), parseInt(take));
  }

  // ── Configuration ──────────────────────────────────────────────────
  @Get('configuration')
  @RequirePermissions('notification.configuration.manage')
  @ApiOperation({ summary: 'Get dynamic configurations' })
  async getConfig() {
    return this.configService.getAll();
  }

  @Patch('configuration')
  @RequirePermissions('notification.configuration.manage')
  @ApiOperation({ summary: 'Update dynamic configuration value' })
  async setConfig(@Body() dto: UpdateConfigDto) {
    await this.configService.set(dto.key, dto.value);
    return { message: 'Configuration successfully updated.' };
  }
}
