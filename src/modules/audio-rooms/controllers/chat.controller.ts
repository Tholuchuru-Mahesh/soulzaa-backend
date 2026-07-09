import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  AnnounceDto,
  ListChatReportsDto,
  ListMessagesDto,
  ReactDto,
  ReportMessageDto,
  ReviewChatReportDto,
  SendMessageDto,
  TypingDto,
} from '../dto/chat.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { ChatService } from '../services/chat.service';

/**
 * AR-4 room-chat REST surface (base `rooms/:id/chat/...`). JWT-guarded globally;
 * membership, mute/ban and pin/announce permission checks live in the service
 * (which also honours platform moderators). Send/react/report/typing/announce
 * are member actions (`@NotGuest`); pin/delete/review enforce moderator or owner
 * authority in the service. Realtime fan-out happens via the chat socket bridge.
 */
@ApiTags('audio-room-chat')
@ApiBearerAuth()
@Controller('rooms')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  // ---- Send / ephemeral ----

  @Post(':id/chat/messages')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Send a chat message (text/emoji/gif)' })
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.chat.sendMessage(this.actor(user), id, dto);
  }

  @Post(':id/chat/typing')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Broadcast a typing indicator' })
  async typing(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: TypingDto,
  ) {
    await this.chat.typing(this.actor(user), id, dto);
    return { ok: true };
  }

  @Post(':id/chat/react')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Send an ephemeral floating emoji reaction' })
  async react(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: ReactDto,
  ) {
    await this.chat.react(this.actor(user), id, dto);
    return { ok: true };
  }

  @Post(':id/chat/announce')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Post an admin announcement (owner/admin)' })
  announce(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: AnnounceDto,
  ) {
    return this.chat.announce(this.actor(user), id, dto);
  }

  // ---- Message actions ----

  @Post(':id/chat/messages/:messageId/pin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pin a message (owner/admin)' })
  pin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
  ) {
    return this.chat.pin(this.actor(user), id, messageId);
  }

  @Post(':id/chat/messages/:messageId/unpin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unpin a message (owner/admin)' })
  async unpin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
  ) {
    await this.chat.unpin(this.actor(user), id, messageId);
    return { unpinned: true };
  }

  @Post(':id/chat/messages/:messageId/delete')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Delete a message (own message or moderator)' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
  ) {
    await this.chat.deleteMessage(this.actor(user), id, messageId);
    return { deleted: true };
  }

  @Post(':id/chat/messages/:messageId/report')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Report a message' })
  report(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
    @Body() dto: ReportMessageDto,
  ) {
    return this.chat.report(this.actor(user), id, messageId, dto);
  }

  @Post(':id/chat/reports/:reportId/review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Review/resolve a chat report (moderator)' })
  async reviewReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('reportId', ParseUuidPipe) reportId: string,
    @Body() dto: ReviewChatReportDto,
  ) {
    await this.chat.reviewReport(this.actor(user), id, reportId, dto);
    return { reviewed: true };
  }

  // ---- Reads ----

  @Get(':id/chat/messages')
  @ApiOperation({ summary: 'Message history (paginated; keyset via `before`)' })
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Query() q: ListMessagesDto,
  ) {
    return this.chat.history(this.actor(user), id, q);
  }

  @Get(':id/chat/pins')
  @ApiOperation({ summary: 'Currently pinned messages' })
  pins(@Param('id', ParseUuidPipe) id: string) {
    return this.chat.listPins(id);
  }

  @Get(':id/chat/reports')
  @ApiOperation({ summary: 'List chat reports (moderator)' })
  reports(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Query() q: ListChatReportsDto,
  ) {
    return this.chat.listReports(this.actor(user), id, q);
  }
}
