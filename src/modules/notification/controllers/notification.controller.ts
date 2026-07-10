import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { NotificationService } from '../services/notification.service';

/** In-app notification center for the authenticated user. */
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
