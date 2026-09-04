import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { RequestMeta } from 'src/common/decorators/request-meta.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  CreateVideoRoomAnnouncementDto,
  UpdateVideoRoomAnnouncementDto,
} from '../dto/announcement.dto';
import {
  ChatMessageView,
  EditChatMessageDto,
  ListChatMessagesDto,
  PinChatMessageDto,
  SearchChatMessagesDto,
  SendChatMessageDto,
  UpdateChatSettingsDto,
} from '../dto/chat';
import type { ChatAuditContext } from '../events/video-room-chat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomAnnouncementService } from '../services/video-room-announcement.service';
import { VideoRoomChatPinService } from '../services/video-room-chat-pin.service';
import { VideoRoomChatQueryService } from '../services/video-room-chat-query.service';
import { VideoRoomChatReceiptService } from '../services/video-room-chat-receipt.service';
import { VideoRoomChatSettingsService } from '../services/video-room-chat-settings.service';
import { VideoRoomChatService } from '../services/video-room-chat.service';

/**
 * VR-9 chat REST surface (base `video-rooms/:id/chat/...`). Durable commands live
 * here — auditable, idempotent, and consistent with every shipped video-room
 * controller. The EPHEMERAL signals (typing, delivered, read) are served by
 * `VideoRoomChatGateway` over the socket instead, where an HTTP round trip per
 * keystroke would be waste.
 *
 * JWT-guarded globally. Every authorization decision lives in
 * `VideoRoomChatPolicyService` / `VideoRoomPermissionService`, never here.
 */
@ApiTags('video-room-chat')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomsChatController {
  constructor(
    private readonly chat: VideoRoomChatService,
    private readonly query: VideoRoomChatQueryService,
    private readonly pins: VideoRoomChatPinService,
    private readonly announcements: VideoRoomAnnouncementService,
    private readonly receipts: VideoRoomChatReceiptService,
    private readonly settings: VideoRoomChatSettingsService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  private audit(meta: RequestMetadata): ChatAuditContext {
    return { ip: meta.ip, requestId: meta.requestId, userAgent: meta.userAgent };
  }

  // ---- Messages ----

  @Post(':id/chat/messages')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Send a chat message (text/emoji/gif)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 201, type: ChatMessageView })
  @ApiResponse({
    status: 403,
    description:
      'CHAT_DISABLED · VIDEO_ROOM_CHAT_MODE_RESTRICTED · MEMBER_MUTED · VIDEO_ROOM_BLOCKED · VIDEO_ROOM_NOT_MEMBER',
  })
  @ApiResponse({ status: 409, description: 'DUPLICATE_MESSAGE · VIDEO_ROOM_ENDED' })
  @ApiResponse({ status: 422, description: 'BLOCKED_WORD' })
  @ApiResponse({ status: 429, description: 'CHAT_RATE_LIMITED · CHAT_SLOW_MODE' })
  async send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: SendChatMessageDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    // Mapped, never the raw Prisma row. The row exposes internal columns and
    // names the primary key `id`, whereas history, the socket broadcast and
    // every other message-carrying surface use `messageId` + ISO `createdAt`.
    // A client that reconciles its optimistic bubble against
    // `video_room.chat_message_sent` needs the SAME id field on both, so the
    // command response has to speak the wire shape too.
    const message = await this.chat.send(this.actor(user), id, dto, this.audit(meta));
    return this.chat.toPayload(message);
  }

  @Patch(':id/chat/messages/:messageId')
  @NotGuest()
  @ApiOperation({ summary: 'Edit your own message (inside the edit window)' })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — not the author' })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_ROOM_MESSAGE_EDIT_WINDOW_EXPIRED · VIDEO_ROOM_MESSAGE_NOT_EDITABLE',
  })
  async edit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
    @Body() dto: EditChatMessageDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    const message = await this.chat.edit(
      this.actor(user),
      id,
      messageId,
      dto.content,
      this.audit(meta),
    );
    return this.chat.toPayload(message);
  }

  @Delete(':id/chat/messages/:messageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NotGuest()
  @ApiOperation({
    summary: 'Delete a message (author, or a moderator)',
    description:
      'Soft delete. Content is withheld from non-moderators but the row is retained for audit. To withdraw your own message from everyone, use recall instead.',
  })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.chat.remove(this.actor(user), id, messageId, this.audit(meta));
  }

  @Post(':id/chat/messages/:messageId/recall')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NotGuest()
  @ApiOperation({
    summary: 'Recall your own message (inside the recall window)',
    description:
      'Withdraws the message from every client, including moderators. Author only — moderators delete, they do not recall.',
  })
  @ApiResponse({ status: 409, description: 'VIDEO_ROOM_MESSAGE_RECALL_WINDOW_EXPIRED' })
  recall(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.chat.recall(this.actor(user), id, messageId, this.audit(meta));
  }

  // ---- Reads ----

  @Get(':id/chat/messages')
  @ApiOperation({
    summary: 'Chat history',
    description:
      'Cursor pagination via `before` (scalable), or page/limit. Page 1 newest-first is served from the Redis ring buffer.',
  })
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Query() q: ListChatMessagesDto,
  ) {
    return this.query.history(this.actor(user), id, q);
  }

  @Get(':id/chat/search')
  @ApiOperation({ summary: 'Search chat by keyword, sender, type or date range' })
  search(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Query() q: SearchChatMessagesDto,
  ) {
    return this.query.search(this.actor(user), id, q);
  }

  @Get(':id/chat/unread')
  @ApiOperation({ summary: 'Unread message count for the caller' })
  unread(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.query.unreadCount(this.actor(user), id);
  }

  @Get(':id/chat/messages/:messageId/readers')
  @ApiOperation({
    summary: 'Who has read this message',
    description: 'Derived from read cursors — no per-message receipt rows exist.',
  })
  readers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
  ) {
    return this.receipts.readers(this.actor(user), id, messageId);
  }

  // ---- Pins ----

  @Get(':id/chat/pinned')
  @ApiOperation({ summary: 'Pinned messages in the room' })
  listPinned(@Param('id', ParseUuidPipe) id: string) {
    return this.pins.listPinned(id);
  }

  @Post(':id/chat/pin')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Pin a message', description: 'Requires PIN_MESSAGES.' })
  @ApiResponse({ status: 409, description: 'ALREADY_PINNED · PIN_LIMIT_REACHED' })
  pin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: PinChatMessageDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.pins.pin(this.actor(user), id, dto.messageId, this.audit(meta));
  }

  @Delete(':id/chat/pin/:messageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NotGuest()
  @ApiOperation({ summary: 'Unpin a message', description: 'Requires PIN_MESSAGES.' })
  @ApiResponse({ status: 404, description: 'PIN_NOT_FOUND' })
  unpin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.pins.unpin(this.actor(user), id, messageId, this.audit(meta));
  }

  // ---- Announcements ----

  @Get(':id/chat/announcements')
  @ApiOperation({ summary: 'Announcement history (pinned first, then newest)' })
  listAnnouncements(@Param('id', ParseUuidPipe) id: string) {
    return this.announcements.list(id);
  }

  @Post(':id/chat/announcements')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({
    summary: 'Post an announcement',
    description:
      'Requires MANAGE_ANNOUNCEMENTS. Also projects an ANNOUNCEMENT-type message into the chat stream.',
  })
  createAnnouncement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: CreateVideoRoomAnnouncementDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.announcements.create(this.actor(user), id, dto, this.audit(meta));
  }

  @Patch(':id/chat/announcements/:announcementId')
  @NotGuest()
  @ApiOperation({ summary: 'Edit an announcement', description: 'Requires MANAGE_ANNOUNCEMENTS.' })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_ANNOUNCEMENT_NOT_FOUND' })
  updateAnnouncement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('announcementId', ParseUuidPipe) announcementId: string,
    @Body() dto: UpdateVideoRoomAnnouncementDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.announcements.update(this.actor(user), id, announcementId, dto, this.audit(meta));
  }

  @Delete(':id/chat/announcements/:announcementId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NotGuest()
  @ApiOperation({
    summary: 'Remove an announcement',
    description: 'Requires MANAGE_ANNOUNCEMENTS.',
  })
  removeAnnouncement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('announcementId', ParseUuidPipe) announcementId: string,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.announcements.remove(this.actor(user), id, announcementId, this.audit(meta));
  }

  // ---- Settings (VR-9.1a — chat-scoped slice only) ----

  @Patch(':id/chat/settings')
  @NotGuest()
  @ApiOperation({
    summary: 'Patch the room chat settings',
    description:
      'Requires MANAGE_ROOM (owner-only). Partial update — only supplied fields change. ' +
      'Setting chatMode also mirrors the deprecated allowViewerChat column server-side.',
  })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — not MANAGE_ROOM' })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND' })
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: UpdateChatSettingsDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.settings.update(this.actor(user), id, dto, this.audit(meta));
  }
}
