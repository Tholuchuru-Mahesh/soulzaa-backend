import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  BlockedWordAction,
  BlockedWordSeverity,
  ChatBlockedWord,
  ChatMessageType,
  ChatReportStatus,
  ModerationActionType,
  PinnedMessage,
  Prisma,
  ReportReason,
  RoomMessage,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { LockService } from 'src/infra/redis/lock.service';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import {
  CHAT_EMOJI_MESSAGE_MAX_LENGTH,
  CHAT_REACTION_EMOJIS,
  chatPinLockKey,
} from '../constants/chat.constants';
import { RoomPermission } from '../constants/room-permissions';
import { SYSTEM_MODERATOR_ID } from '../constants/moderation.constants';
import type {
  AnnounceDto,
  BlockedWordDto,
  ListBlockedWordsDto,
  ListChatReportsDto,
  ListMessagesDto,
  ReactDto,
  ReportMessageDto,
  ReviewChatReportDto,
  SendMessageDto,
  TypingDto,
  UpdateBlockedWordDto,
} from '../dto/chat.dto';
import {
  ChatAnnouncementEvent,
  ChatMentionEvent,
  ChatMessageDeletedEvent,
  ChatMessagePinnedEvent,
  ChatMessageSentEvent,
  ChatMessageUnpinnedEvent,
  ChatReactionEvent,
  ChatReportedEvent,
  ChatTypingEvent,
  type ChatMessagePayload,
} from '../events/audio-room-chat.events';
import { MemberReportedEvent } from '../events/audio-room-moderation.events';
import type { IAudioRoomChatService } from '../interfaces/chat.service.interface';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { BlockedWordService } from 'src/infra/content-moderation';
import { AudioRoomSeatsRepository } from '../repositories/audio-room-seats.repository';
import { AudioRoomsRepository } from '../repositories/audio-rooms.repository';
import { ChatRepository } from '../repositories/chat.repository';
import { ModerationRepository } from '../repositories/moderation.repository';
import { ModerationService } from './moderation.service';
import { RoomPermissionService } from './room-permission.service';

/** Resolved chat tuning (read once from config per call site). */
interface ChatConfig {
  messageMaxLength: number;
  maxMentions: number;
  maxPins: number;
  rateMax: number;
  rateWindowSeconds: number;
  dedupWindowSeconds: number;
  reactRateMax: number;
  reactRateWindowSeconds: number;
  violationWindowSeconds: number;
  autoMuteThreshold: number;
  autoKickThreshold: number;
  autoMuteMinutes: number;
}

/** Matches `@username` mentions (3–30 word chars, ASCII usernames). */
const MENTION_RE = /@([a-zA-Z0-9_]{3,30})/g;

/**
 * AR-4 room chat: send/pin/delete/announce/react/typing/report over the existing
 * `/audio-room` namespace, with persist-then-broadcast delivery, mention
 * resolution, message history, and a full anti-abuse layer — rate limiting,
 * slow-mode, duplicate suppression, and the severity-based blocked-word engine
 * integrated with AR-3 (audit trail + auto mute/kick escalation). Same-module
 * repositories/services are injected directly; users are resolved via the
 * cross-module `USERS_SERVICE` contract.
 */
@Injectable()
export class ChatService implements IAudioRoomChatService {
  constructor(
    private readonly chatRepo: ChatRepository,
    private readonly blockedWords: BlockedWordService,
    private readonly permissions: RoomPermissionService,
    private readonly moderation: ModerationService,
    private readonly modRepo: ModerationRepository,
    private readonly rooms: AudioRoomsRepository,
    private readonly seats: AudioRoomSeatsRepository,
    private readonly locks: LockService,
    private readonly config: ConfigService,
    private readonly queue: QueueService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
  ) {}

  // ======================= Send =======================

  async sendMessage(actor: RoomActor, roomId: string, dto: SendMessageDto): Promise<RoomMessage> {
    const cfg = this.chatConfig();
    await this.assertCanChat(roomId, actor.id);

    const content = dto.content.trim();
    this.assertLength(content, dto.type, cfg);

    // Anti-abuse gates (rate → slow-mode → duplicate).
    if (await this.chatRepo.hitRateLimit(roomId, actor.id, cfg.rateMax, cfg.rateWindowSeconds)) {
      throw new BusinessException(
        ERROR_CODES.CHAT_RATE_LIMITED,
        'You are sending messages too quickly.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (await this.chatRepo.isSlowModeActive(roomId, actor.id)) {
      throw new BusinessException(
        ERROR_CODES.CHAT_SLOW_MODE,
        'Slow mode is enabled — please wait before sending again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const hash = this.hashContent(content);
    if (await this.chatRepo.isDuplicate(roomId, actor.id, hash, cfg.dedupWindowSeconds)) {
      throw new BusinessException(
        ERROR_CODES.DUPLICATE_MESSAGE,
        'Duplicate message ignored.',
        HttpStatus.CONFLICT,
      );
    }

    // Blocked-word moderation (mask / reject / escalate).
    const finalContent = await this.applyModeration(roomId, actor.id, content);

    // Resolve @mentions to user ids (capped).
    const mentions = await this.resolveMentions(content, actor.id, cfg.maxMentions);

    const message = await this.chatRepo.createMessage({
      roomId,
      senderId: actor.id,
      type: dto.type,
      content: finalContent,
      gifUrl: dto.gifUrl ?? null,
      mentions,
      replyToId: dto.replyToId ?? null,
    });

    const payload = this.toPayload(message);
    await this.bus.publish(new ChatMessageSentEvent(payload));

    if (mentions.length > 0) {
      await this.bus.publish(
        new ChatMentionEvent({
          roomId,
          messageId: message.id,
          senderId: actor.id,
          recipientIds: mentions,
        }),
      );
      await this.queue.enqueue(QUEUE_NAMES.NOTIFICATIONS, 'chat.mention', {
        roomId,
        messageId: message.id,
        senderId: actor.id,
        recipientIds: mentions,
      });
    }

    await this.chatRepo.setSlowMode(roomId, actor.id, await this.slowModeSeconds(roomId));
    await this.queue.enqueue(QUEUE_NAMES.ANALYTICS_PROCESSING, 'chat.message', {
      roomId,
      messageId: message.id,
      senderId: actor.id,
      type: message.type,
    });
    return message;
  }

  // ======================= Typing / reactions (ephemeral) =======================

  async typing(actor: RoomActor, roomId: string, dto: TypingDto): Promise<void> {
    await this.assertActiveMember(roomId, actor.id);
    await this.bus.publish(
      new ChatTypingEvent({ roomId, userId: actor.id, isTyping: dto.isTyping }),
    );
  }

  async react(actor: RoomActor, roomId: string, dto: ReactDto): Promise<void> {
    const cfg = this.chatConfig();
    await this.assertActiveMember(roomId, actor.id);
    if (await this.moderation.isMuted(roomId, actor.id)) {
      throw new BusinessException(
        ERROR_CODES.MEMBER_MUTED,
        'You are muted in this room.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!CHAT_REACTION_EMOJIS.includes(dto.emoji)) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Unsupported reaction emoji.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      await this.chatRepo.hitReactRateLimit(
        roomId,
        actor.id,
        cfg.reactRateMax,
        cfg.reactRateWindowSeconds,
      )
    ) {
      throw new BusinessException(
        ERROR_CODES.CHAT_RATE_LIMITED,
        'Too many reactions — slow down.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await this.bus.publish(new ChatReactionEvent({ roomId, userId: actor.id, emoji: dto.emoji }));
  }

  // ======================= Pin / unpin =======================

  async pin(actor: RoomActor, roomId: string, messageId: string): Promise<PinnedMessage> {
    await this.permissions.assertPermission(roomId, actor, RoomPermission.PIN_MESSAGES);
    const cfg = this.chatConfig();
    return this.locks.withLock(chatPinLockKey(roomId), async () => {
      const message = await this.chatRepo.getMessage(messageId);
      if (!message || message.roomId !== roomId || message.isDeleted) {
        throw new BusinessException(
          ERROR_CODES.MESSAGE_NOT_FOUND,
          'Message not found.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (await this.chatRepo.getActivePin(roomId, messageId)) {
        throw new BusinessException(
          ERROR_CODES.ALREADY_PINNED,
          'That message is already pinned.',
          HttpStatus.CONFLICT,
        );
      }
      if ((await this.chatRepo.countActivePins(roomId)) >= cfg.maxPins) {
        throw new BusinessException(
          ERROR_CODES.CONFLICT,
          `A room may have at most ${cfg.maxPins} pinned messages.`,
          HttpStatus.CONFLICT,
        );
      }
      const pin = await this.chatRepo.pin({ roomId, messageId, pinnedBy: actor.id });
      await this.bus.publish(new ChatMessagePinnedEvent({ roomId, messageId, pinnedBy: actor.id }));
      return pin;
    });
  }

  async unpin(actor: RoomActor, roomId: string, messageId: string): Promise<void> {
    await this.permissions.assertPermission(roomId, actor, RoomPermission.PIN_MESSAGES);
    await this.locks.withLock(chatPinLockKey(roomId), async () => {
      const pin = await this.chatRepo.getActivePin(roomId, messageId);
      if (!pin) {
        throw new BusinessException(
          ERROR_CODES.PIN_NOT_FOUND,
          'That message is not pinned.',
          HttpStatus.NOT_FOUND,
        );
      }
      await this.chatRepo.unpin(pin.id, actor.id);
      await this.bus.publish(
        new ChatMessageUnpinnedEvent({ roomId, messageId, unpinnedBy: actor.id }),
      );
    });
  }

  // ======================= Delete =======================

  async deleteMessage(actor: RoomActor, roomId: string, messageId: string): Promise<void> {
    const message = await this.chatRepo.getMessage(messageId);
    if (!message || message.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.MESSAGE_NOT_FOUND,
        'Message not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (message.isDeleted) return;

    const isOwn = message.senderId === actor.id;
    if (!isOwn) await this.permissions.assertCanModerate(roomId, actor);

    await this.chatRepo.softDeleteMessage(messageId, actor.id);
    // Unpin if it was pinned.
    const pin = await this.chatRepo.getActivePin(roomId, messageId);
    if (pin) await this.chatRepo.unpin(pin.id, actor.id);

    if (!isOwn) {
      await this.modRepo.appendAction({
        roomId,
        moderatorId: actor.id,
        targetUserId: message.senderId,
        action: ModerationActionType.CHAT_MESSAGE_DELETED,
        metadata: { messageId },
      });
    }
    await this.bus.publish(
      new ChatMessageDeletedEvent({ roomId, messageId, deletedBy: actor.id, byModerator: !isOwn }),
    );
  }

  // ======================= Announcements =======================

  async announce(actor: RoomActor, roomId: string, dto: AnnounceDto): Promise<RoomMessage> {
    await this.permissions.assertPermission(roomId, actor, RoomPermission.PIN_MESSAGES);
    const message = await this.chatRepo.createMessage({
      roomId,
      senderId: actor.id,
      type: ChatMessageType.ANNOUNCEMENT,
      content: dto.content.trim(),
      gifUrl: null,
      mentions: [],
      replyToId: null,
    });

    await this.locks.withLock(chatPinLockKey(roomId), async () => {
      const cfg = this.chatConfig();
      const activePinsCount = await this.chatRepo.countActivePins(roomId);
      if (activePinsCount >= cfg.maxPins) {
        const activePins = await this.chatRepo.listActivePins(roomId);
        for (const pin of activePins) {
          await this.chatRepo.unpin(pin.id, actor.id);
          await this.bus.publish(
            new ChatMessageUnpinnedEvent({
              roomId,
              messageId: pin.messageId,
              unpinnedBy: actor.id,
            }),
          );
        }
      }
      await this.chatRepo.pin({ roomId, messageId: message.id, pinnedBy: actor.id });
      await this.bus.publish(
        new ChatMessagePinnedEvent({ roomId, messageId: message.id, pinnedBy: actor.id }),
      );
    });

    await this.bus.publish(new ChatAnnouncementEvent(this.toPayload(message)));
    return message;
  }

  // ======================= Reports =======================

  async report(
    actor: RoomActor,
    roomId: string,
    messageId: string,
    dto: ReportMessageDto,
  ): Promise<{ id: string }> {
    const message = await this.chatRepo.getMessage(messageId);
    if (!message || message.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.MESSAGE_NOT_FOUND,
        'Message not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (message.senderId === actor.id) {
      throw new BusinessException(
        ERROR_CODES.CANNOT_MODERATE_SELF,
        'You cannot report your own message.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (await this.chatRepo.findOpenReport(roomId, actor.id, messageId)) {
      throw new BusinessException(
        ERROR_CODES.DUPLICATE_REPORT,
        'You already have a pending report for this message.',
        HttpStatus.CONFLICT,
      );
    }
    const report = await this.chatRepo.createReport({
      roomId,
      messageId,
      reporterId: actor.id,
      targetUserId: message.senderId,
      reason: dto.reason,
      description: dto.description ?? null,
    });
    const recipientIds = await this.moderatorRecipients(roomId, actor.id);
    await this.bus.publish(
      new ChatReportedEvent({
        roomId,
        reportId: report.id,
        messageId,
        reporterId: actor.id,
        targetUserId: message.senderId,
        reason: dto.reason,
        recipientIds,
      }),
    );
    await this.queue.enqueue(QUEUE_NAMES.NOTIFICATIONS, 'chat.report', {
      roomId,
      reportId: report.id,
      messageId,
      recipientIds,
    });
    return { id: report.id };
  }

  async reviewReport(
    actor: RoomActor,
    roomId: string,
    reportId: string,
    dto: ReviewChatReportDto,
  ): Promise<void> {
    await this.permissions.assertCanModerate(roomId, actor);
    const report = await this.chatRepo.getReport(reportId);
    if (!report || report.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.CHAT_REPORT_NOT_FOUND,
        'Report not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (report.status !== ChatReportStatus.PENDING) {
      throw new BusinessException(
        ERROR_CODES.CHAT_REPORT_NOT_FOUND,
        'Report already reviewed.',
        HttpStatus.CONFLICT,
      );
    }
    await this.chatRepo.reviewReport(reportId, actor.id, dto.status, dto.resolution ?? null);
    await this.modRepo.appendAction({
      roomId,
      moderatorId: actor.id,
      targetUserId: report.targetUserId,
      action: ModerationActionType.REPORT_REVIEWED,
      reason: dto.resolution ?? null,
      metadata: { chatReportId: reportId, messageId: report.messageId, status: dto.status },
    });
  }

  // ======================= Reads =======================

  async history(actor: RoomActor, roomId: string, q: ListMessagesDto): Promise<Paginated<unknown>> {
    const includeDeleted = await this.permissions.canModerate(roomId, actor);
    const [rows, total] = await this.chatRepo.listMessages(roomId, {
      skip: q.skip,
      take: q.limit,
      before: q.before,
      includeDeleted,
    });
    return buildPaginated(rows, total, q.page, q.limit);
  }

  async listPins(roomId: string): Promise<any[]> {
    const pins = await this.chatRepo.listActivePins(roomId);
    const result = [];
    for (const pin of pins) {
      const message = await this.chatRepo.getMessage(pin.messageId);
      result.push({
        ...pin,
        message: message ? this.toPayload(message) : null,
      });
    }
    return result;
  }

  async listReports(
    actor: RoomActor,
    roomId: string,
    q: ListChatReportsDto,
  ): Promise<Paginated<unknown>> {
    await this.permissions.assertCanModerate(roomId, actor);
    const [rows, total] = await this.chatRepo.listReports(roomId, q.skip, q.limit, q.status);
    return buildPaginated(rows, total, q.page, q.limit);
  }

  // ======================= Admin blocked-word dictionary =======================

  async listWords(q: ListBlockedWordsDto): Promise<Paginated<ChatBlockedWord>> {
    const [rows, total] = await this.chatRepo.listWords(q.skip, q.limit, {
      language: q.language,
      enabled: q.enabled,
    });
    return buildPaginated(rows, total, q.page, q.limit);
  }

  async createWord(actorId: string, dto: BlockedWordDto): Promise<ChatBlockedWord> {
    const word = await this.chatRepo.createWord(
      {
        pattern: dto.pattern,
        isRegex: dto.isRegex ?? false,
        language: dto.language ?? 'en',
        severity: dto.severity,
        action: dto.action,
        enabled: dto.enabled ?? true,
        notes: dto.notes ?? null,
      },
      actorId,
    );
    await this.blockedWords.invalidate();
    return word;
  }

  async updateWord(
    actorId: string,
    id: string,
    dto: UpdateBlockedWordDto,
  ): Promise<ChatBlockedWord> {
    if (!(await this.chatRepo.getWord(id))) {
      throw new BusinessException(
        ERROR_CODES.BLOCKED_WORD_NOT_FOUND,
        'Blocked word not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const data: Prisma.ChatBlockedWordUpdateInput = {
      ...(dto.pattern !== undefined ? { pattern: dto.pattern } : {}),
      ...(dto.isRegex !== undefined ? { isRegex: dto.isRegex } : {}),
      ...(dto.language !== undefined ? { language: dto.language } : {}),
      ...(dto.severity !== undefined ? { severity: dto.severity } : {}),
      ...(dto.action !== undefined ? { action: dto.action } : {}),
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    };
    const word = await this.chatRepo.updateWord(id, data, actorId);
    await this.blockedWords.invalidate();
    return word;
  }

  async deleteWord(id: string): Promise<void> {
    if (!(await this.chatRepo.getWord(id))) {
      throw new BusinessException(
        ERROR_CODES.BLOCKED_WORD_NOT_FOUND,
        'Blocked word not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.chatRepo.deleteWord(id);
    await this.blockedWords.invalidate();
  }

  // ======================= IAudioRoomChatService =======================

  getActivePins(roomId: string): Promise<PinnedMessage[]> {
    return this.chatRepo.listActivePins(roomId);
  }

  async isChatEnabled(roomId: string): Promise<boolean> {
    const settings = await this.rooms.getSettings(roomId);
    return settings?.allowChat ?? false;
  }

  // ======================= Internals =======================

  private chatConfig(): ChatConfig {
    return (this.config.get('audioRoom') as { chat: ChatConfig }).chat;
  }

  private hashContent(content: string): string {
    return createHash('sha1').update(content.toLowerCase()).digest('hex');
  }

  private assertLength(content: string, type: ChatMessageType, cfg: ChatConfig): void {
    const max =
      type === ChatMessageType.EMOJI ? CHAT_EMOJI_MESSAGE_MAX_LENGTH : cfg.messageMaxLength;
    if (content.length === 0 || content.length > max) {
      throw new BusinessException(
        ERROR_CODES.MESSAGE_TOO_LONG,
        `Message must be between 1 and ${max} characters.`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /** Membership + live + chat-enabled + not-banned + not-muted gate. */
  private async assertCanChat(roomId: string, userId: string): Promise<void> {
    await this.assertActiveMember(roomId, userId);
    if (!(await this.rooms.findLiveRoomRow(roomId))) {
      throw new BusinessException(
        ERROR_CODES.ROOM_ENDED,
        'This room is not live.',
        HttpStatus.CONFLICT,
      );
    }
    const settings = await this.rooms.getSettings(roomId);
    if (settings && !settings.allowChat) {
      throw new BusinessException(
        ERROR_CODES.CHAT_DISABLED,
        'Chat is disabled in this room.',
        HttpStatus.FORBIDDEN,
      );
    }
    await this.moderation.assertNotBanned(roomId, userId);
    if (await this.moderation.isMuted(roomId, userId)) {
      throw new BusinessException(
        ERROR_CODES.MEMBER_MUTED,
        'You are muted in this room.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async assertActiveMember(roomId: string, userId: string): Promise<void> {
    const member = await this.rooms.getMember(roomId, userId);
    if (!member?.isActive) {
      throw new BusinessException(
        ERROR_CODES.NOT_ROOM_MEMBER,
        'You are not a member of this room.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async slowModeSeconds(roomId: string): Promise<number> {
    const settings = await this.rooms.getSettings(roomId);
    return settings?.chatSlowModeSeconds ?? 0;
  }

  /**
   * Run the message through the blocked-word engine. MILD → return the masked
   * text (message continues). OFFENSIVE/CRITICAL → audit, record a violation and
   * throw `BLOCKED_WORD`; CRITICAL additionally opens an AR-3 report and triggers
   * the moderation workflow. Every decision is audit-logged (immutable history).
   */
  private async applyModeration(roomId: string, userId: string, content: string): Promise<string> {
    const scan = this.blockedWords.scan(content);
    if (!scan.matched) return content;

    const severity = scan.severity!;
    const meta = { severity, matches: scan.matches };

    if (scan.action === BlockedWordAction.MASK) {
      await this.modRepo.appendAction({
        roomId,
        moderatorId: null,
        targetUserId: userId,
        action: ModerationActionType.CHAT_WORD_MASKED,
        metadata: meta,
      });
      await this.recordViolation(roomId, userId, severity);
      return scan.maskedText;
    }

    if (scan.action === BlockedWordAction.REJECT) {
      await this.modRepo.appendAction({
        roomId,
        moderatorId: null,
        targetUserId: userId,
        action: ModerationActionType.CHAT_WORD_REJECTED,
        metadata: meta,
      });
      await this.recordViolation(roomId, userId, severity);
      throw this.blockedWordError();
    }

    // ESCALATE (critical): reject, audit, open an AR-3 report, trigger workflow.
    await this.modRepo.appendAction({
      roomId,
      moderatorId: null,
      targetUserId: userId,
      action: ModerationActionType.CHAT_WORD_ESCALATED,
      metadata: meta,
    });
    await this.escalateCritical(roomId, userId, scan.matches);
    await this.recordViolation(roomId, userId, severity);
    throw this.blockedWordError();
  }

  private blockedWordError(): BusinessException {
    return new BusinessException(
      ERROR_CODES.BLOCKED_WORD,
      'Your message was blocked by the community guidelines filter.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  /** Open a system report against a critical-word sender and notify moderators. */
  private async escalateCritical(roomId: string, userId: string, matches: string[]): Promise<void> {
    const report = await this.modRepo.createReport({
      roomId,
      reporterId: SYSTEM_MODERATOR_ID,
      targetUserId: userId,
      reason: ReportReason.ABUSE,
      description: `Automated escalation: critical blocked term(s) detected [${matches.join(', ')}].`,
    });
    const recipientIds = await this.moderatorRecipients(roomId, userId);
    await this.bus.publish(
      new MemberReportedEvent({
        roomId,
        reportId: report.id,
        reporterId: SYSTEM_MODERATOR_ID,
        targetUserId: userId,
        reason: ReportReason.ABUSE,
        recipientIds,
      }),
    );
    await this.queue.enqueue(QUEUE_NAMES.NOTIFICATIONS, 'moderation.report', {
      roomId,
      reportId: report.id,
      recipientIds,
    });
  }

  /**
   * Increment the rolling violation counter and auto-escalate on threshold:
   * kick takes priority over mute. Both are system-initiated (no actor auth).
   */
  private async recordViolation(
    roomId: string,
    userId: string,
    severity: BlockedWordSeverity,
  ): Promise<void> {
    const cfg = this.chatConfig();
    const count = await this.chatRepo.incrViolation(roomId, userId, cfg.violationWindowSeconds);
    const reason = `Automated chat moderation: ${count} violation(s) within window (last: ${severity}).`;
    if (count >= cfg.autoKickThreshold) {
      await this.moderation.autoKick(roomId, userId, reason);
    } else if (count >= cfg.autoMuteThreshold) {
      await this.moderation.autoMute(roomId, userId, reason, cfg.autoMuteMinutes);
    }
  }

  /** Resolve `@username` tokens (and any dto-supplied usernames) to user ids. */
  private async resolveMentions(content: string, senderId: string, max: number): Promise<string[]> {
    const usernames = new Set<string>();
    for (const m of content.matchAll(MENTION_RE)) usernames.add(m[1].toLowerCase());
    if (usernames.size === 0) return [];

    const ids = new Set<string>();
    for (const username of usernames) {
      if (ids.size >= max) break;
      const user = await this.users.findByUsername(username);
      if (user && user.id !== senderId) ids.add(user.id);
    }
    return [...ids];
  }

  /** Owner + elevated members to notify (excluding the actor). */
  private async moderatorRecipients(roomId: string, excludeUserId: string): Promise<string[]> {
    const ids = new Set(await this.seats.listElevatedMemberIds(roomId));
    const owner = await this.rooms.getOwnerId(roomId);
    if (owner) ids.add(owner);
    ids.delete(excludeUserId);
    return [...ids];
  }

  private toPayload(message: RoomMessage): ChatMessagePayload {
    return {
      id: message.id,
      roomId: message.roomId,
      senderId: message.senderId,
      type: message.type,
      content: message.content,
      gifUrl: message.gifUrl,
      mentions: message.mentions,
      replyToId: message.replyToId,
      createdAt: message.createdAt.toISOString(),
    };
  }
}
