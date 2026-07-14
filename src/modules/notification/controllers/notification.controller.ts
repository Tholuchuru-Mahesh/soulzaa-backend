import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { UpdateNotificationPreferencesDto } from '../dto/notification.dto';
import type { NotificationPreferenceView } from '../interfaces/notification.interface';
import { NotificationService } from '../services/notification.service';

/**
 * In-app notification centre for the authenticated user.
 *
 * The list and the unread count are reads for a cold start. Once a client has a
 * socket it should not come back here for the badge: `notification.new` and
 * `notification.read` on `/notifications` carry the fresh `unreadCount` along with
 * the change that caused it, so the number and the list cannot drift apart — which
 * is what always eventually happens when the two are fetched separately.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @ApiOperation({ summary: 'List my notifications' })
  list(@CurrentUser('id') userId: string, @Query() q: PaginationQueryDto) {
    return this.notifications.list(userId, q.page, q.limit);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'My unread notification count' })
  async unread(@CurrentUser('id') userId: string) {
    return { count: await this.notifications.unreadCount(userId) };
  }

  @Get('preferences')
  @ApiOperation({
    summary: 'My notification preferences',
    description: 'A user who has never changed a setting gets the defaults, all enabled.',
  })
  preferences(@CurrentUser('id') userId: string): Promise<NotificationPreferenceView> {
    return this.notifications.preferences(userId);
  }

  @Put('preferences')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update my notification preferences',
    description:
      'Partial: an omitted field is left unchanged. Send `mutedUntil: null` to cancel a snooze. ' +
      "Echoed to the caller's other devices as `notification.preferences`.",
  })
  update(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferenceView> {
    const { mutedUntil, ...rest } = dto;
    return this.notifications.updatePreferences(userId, {
      ...rest,
      // The DTO carries an ISO string, or an explicit null to cancel the snooze; the
      // domain wants a Date. `undefined` must stay undefined — that is what "leave
      // this column alone" means to Prisma, and to this endpoint.
      ...(mutedUntil !== undefined
        ? { mutedUntil: mutedUntil === null ? null : new Date(mutedUntil) }
        : {}),
    });
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a notification read' })
  async read(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.notifications.markRead(userId, id);
    return { read: true };
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all my notifications read' })
  async readAll(@CurrentUser('id') userId: string) {
    await this.notifications.markAllRead(userId);
    return { read: true };
  }
}
