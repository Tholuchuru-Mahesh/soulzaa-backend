import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { EditMessageDto, ListStarredDto, ReactDto } from '../dto/chat.dto';
import { ChatService } from '../services/chat.service';

/**
 * Message-scoped actions and the unread badge. Addressed by message id rather
 * than nested under a conversation, because the client already holds the id and
 * a second path segment would buy nothing — participation is verified in the
 * service from the message's own conversation either way.
 */
@ApiTags('chat')
@ApiBearerAuth()
@Controller('chat')
export class MessagesController {
  constructor(private readonly chat: ChatService) {}

  @Post('messages/:messageId/delete')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Delete your own message' })
  async remove(
    @CurrentUser('id') userId: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
  ) {
    await this.chat.deleteMessage(userId, messageId);
    return { deleted: true };
  }

  @Post('messages/:messageId/edit')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Edit your own message, within the edit window' })
  edit(
    @CurrentUser('id') userId: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
    @Body() dto: EditMessageDto,
  ) {
    return this.chat.editMessage(userId, messageId, dto.content);
  }

  @Post('messages/:messageId/react')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Add an emoji reaction' })
  async react(
    @CurrentUser('id') userId: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
    @Body() dto: ReactDto,
  ) {
    await this.chat.react(userId, messageId, dto.emoji);
    return { ok: true };
  }

  @Post('messages/:messageId/unreact')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Remove an emoji reaction' })
  async unreact(
    @CurrentUser('id') userId: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
    @Body() dto: ReactDto,
  ) {
    await this.chat.unreact(userId, messageId, dto.emoji);
    return { ok: true };
  }

  /**
   * "Delete for me". A separate route from `delete` on purpose.
   *
   * Folding a `scope` flag into the existing delete would silently re-point an
   * endpoint that shipped clients already call. The two also differ in who may act
   * — `delete` is the sender's alone, this is any participant's — and in what they
   * leave behind: delete-for-everyone keeps a tombstone both sides see, this
   * removes the message from one user's history entirely.
   */
  @Post('messages/:messageId/hide')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Delete a message for yourself (the peer keeps their copy)' })
  async hide(
    @CurrentUser('id') userId: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
  ) {
    await this.chat.hideMessage(userId, messageId);
    return { hidden: true };
  }

  // ---- Starring (private to the user; the peer is never told) ----

  @Post('messages/:messageId/star')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Star a message. Idempotent.' })
  async star(
    @CurrentUser('id') userId: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
  ) {
    await this.chat.star(userId, messageId);
    return { starred: true };
  }

  @Post('messages/:messageId/unstar')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Remove a star. Idempotent.' })
  async unstar(
    @CurrentUser('id') userId: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
  ) {
    await this.chat.unstar(userId, messageId);
    return { starred: false };
  }

  @Get('starred')
  @ApiOperation({ summary: 'The messages this user starred, newest first' })
  starred(@CurrentUser('id') userId: string, @Query() q: ListStarredDto) {
    return this.chat.listStarred(userId, {
      page: q.page,
      limit: q.limit,
      conversationId: q.conversationId,
      cursor: q.cursor,
    });
  }

  @Get('unread')
  @ApiOperation({ summary: 'Unread totals for the Chats tab badge' })
  unread(@CurrentUser('id') userId: string) {
    return this.chat.unreadTotal(userId);
  }
}
