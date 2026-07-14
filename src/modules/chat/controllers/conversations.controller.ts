import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  ListConversationsDto,
  ListMediaDto,
  ListMessagesDto,
  MarkReadDto,
  OpenConversationDto,
  PinMessageDto,
  ReportConversationDto,
  SaveDraftDto,
  SendMessageDto,
  TypingDto,
  UpdateConversationSettingsDto,
} from '../dto/chat.dto';
import { ChatService } from '../services/chat.service';

/**
 * Direct-messaging REST surface (base `chat/conversations`). JWT-guarded
 * globally; participation, the privacy gate (`PrivacyAction.MESSAGE`) and chat-
 * request rules are enforced in the service.
 *
 * Every mutation is an HTTP route by design — the `/chat` socket namespace is a
 * pure fan-out channel and accepts no client commands, matching the platform
 * convention. That keeps auth, validation, rate limiting and the error envelope
 * uniform across writes.
 *
 * Guests may read but not write (`@NotGuest`).
 */
@ApiTags('chat')
@ApiBearerAuth()
@Controller('chat/conversations')
export class ConversationsController {
  constructor(private readonly chat: ChatService) {}

  // ---- Conversations ----

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Open (or resume) a direct conversation with a user' })
  open(@CurrentUser('id') userId: string, @Body() dto: OpenConversationDto) {
    return this.chat.openDirect(userId, dto.peerUserId);
  }

  @Get()
  @ApiOperation({ summary: 'List conversations (INBOX | ARCHIVED | REQUESTS)' })
  list(@CurrentUser('id') userId: string, @Query() q: ListConversationsDto) {
    return this.chat.listConversations(userId, {
      page: q.page,
      limit: q.limit,
      filter: q.filter,
      search: q.search,
      cursor: q.cursor,
    });
  }

  @Get('categories')
  @ApiOperation({ summary: 'Badge counts for every Chats-screen category chip' })
  categories(@CurrentUser('id') userId: string) {
    return this.chat.categoryCounts(userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Conversation detail' })
  get(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    return this.chat.getConversation(userId, id);
  }

  @Put(':id/settings')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Pin / archive / mute a conversation (synced across devices)' })
  updateSettings(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: UpdateConversationSettingsDto,
  ) {
    return this.chat.updateSettings(userId, id, {
      isPinned: dto.isPinned,
      isArchived: dto.isArchived,
      isFavorite: dto.isFavorite,
      isMuted: dto.isMuted,
      mutedUntil: dto.mutedUntil ? new Date(dto.mutedUntil) : undefined,
      wallpaper: dto.wallpaper,
    });
  }

  @Put(':id/draft')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Save the composer draft (synced across devices)' })
  async saveDraft(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: SaveDraftDto,
  ) {
    await this.chat.saveDraft(userId, id, dto.text ?? null);
    return { ok: true };
  }

  /**
   * The message pinned to the top of the thread.
   *
   * Deliberately NOT called "pin": `PUT :id/settings` already carries `isPinned`,
   * which pins the *conversation* in the Chats list. Two different features, and
   * overloading the word would confuse them forever.
   *
   * Single-slot and shared: either participant may pin, both see the banner, and
   * pinning replaces whatever was pinned before.
   */
  @Post(':id/pinned-message')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Pin a message to the top of the thread' })
  pinMessage(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: PinMessageDto,
  ) {
    return this.chat.pinMessage(userId, id, dto.messageId);
  }

  @Delete(':id/pinned-message')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Remove the thread’s pinned message' })
  unpinMessage(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    return this.chat.unpinMessage(userId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Clear history for yourself (the peer keeps their copy)' })
  async clear(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    await this.chat.clearHistory(userId, id);
    return { cleared: true };
  }

  // ---- Chat requests ----

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Accept a pending chat request' })
  accept(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    return this.chat.acceptRequest(userId, id);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Decline a pending chat request' })
  async decline(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    await this.chat.declineRequest(userId, id);
    return { declined: true };
  }

  // ---- Messages ----

  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({
    summary: 'Send a message. Idempotent on `clientId` — safe to retry.',
  })
  send(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.chat.sendMessage(userId, id, {
      clientId: dto.clientId,
      type: dto.type,
      content: dto.content ?? '',
      replyToId: dto.replyToId,
      attachments: dto.attachments,
      metadata: dto.metadata,
    });
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Message history (newest-first; keyset via `before`)' })
  history(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Query() q: ListMessagesDto,
  ) {
    return this.chat.history(userId, id, { page: q.page, limit: q.limit, before: q.before });
  }

  @Get(':id/media')
  @ApiOperation({ summary: "The conversation's media, by tab" })
  media(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Query() q: ListMediaDto,
  ) {
    return this.chat.listMedia(userId, id, { page: q.page, limit: q.limit, tab: q.tab });
  }

  // ---- Receipts & indicators ----

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Advance the read watermark to a message' })
  async read(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: MarkReadDto,
  ) {
    await this.chat.markRead(userId, id, dto.messageId);
    return { ok: true };
  }

  @Post(':id/unread')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'Mark unread. Restores the badge without rewinding the peer-visible read receipt.',
  })
  async unread(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    await this.chat.markUnread(userId, id);
    return { ok: true };
  }

  @Post(':id/report')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Report the conversation, or one message in it' })
  report(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: ReportConversationDto,
  ) {
    return this.chat.report(userId, id, {
      reason: dto.reason,
      messageId: dto.messageId,
      description: dto.description,
    });
  }

  @Post(':id/delivered')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Advance the delivered watermark to a message' })
  async delivered(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: MarkReadDto,
  ) {
    await this.chat.markDelivered(userId, id, dto.messageId);
    return { ok: true };
  }

  @Post(':id/typing')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Broadcast a typing / voice-recording indicator' })
  async typing(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: TypingDto,
  ) {
    await this.chat.typing(userId, id, dto.isTyping, dto.kind);
    return { ok: true };
  }
}
