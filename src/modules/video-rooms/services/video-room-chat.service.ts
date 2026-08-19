import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlockedWordAction, VideoRoomMessage, VideoRoomMessageType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { BlockedWordService } from 'src/infra/content-moderation';
import { toChatMessagePayload } from '../dto/chat/chat-message.mapper';
import { loadVideoRoomChatConfig } from '../config/video-room-chat.config';
import {
  ChatMentionedEvent,
  ChatMessageDeletedEvent,
  ChatMessageEditedEvent,
  ChatMessageRecalledEvent,
  ChatMessageSentEvent,
  ChatSpamDetectedEvent,
  type ChatAuditContext,
  type ChatMessagePayload,
} from '../events/video-room-chat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomChatRepository } from '../repositories/video-room-chat.repository';
import { VideoRoomChatCacheService } from './video-room-chat-cache.service';
import { VideoRoomChatPolicyService } from './video-room-chat-policy.service';
import { VideoRoomChatRateLimiter } from './video-room-chat-rate-limiter.service';
import { VideoRoomMentionResolver } from './video-room-mention-resolver.service';

export interface SendChatMessageInput {
  content: string;
  type?: VideoRoomMessageType;
  replyToId?: string;
  forwardedFromId?: string;
  attachments?: unknown[];
}

/**
 * VR-9 chat commands. The send path runs its gates in a deliberate order —
 * policy → rate limit → word scan → mention resolution → persist → cache →
 * publish — so that every rejection happens BEFORE the insert. Nothing after the
 * write can fail the message, which is what removes the partial-write window.
 *
 * Persist-then-broadcast: the durable row exists (real id, real ordering) before
 * any client hears about it. The Redis ring buffer is written alongside purely to
 * keep the read path off Postgres.
 */
@Injectable()
export class VideoRoomChatService {
  private readonly logger = new Logger(VideoRoomChatService.name);

  constructor(
    private readonly policy: VideoRoomChatPolicyService,
    private readonly limiter: VideoRoomChatRateLimiter,
    private readonly words: BlockedWordService,
    private readonly mentions: VideoRoomMentionResolver,
    private readonly repo: VideoRoomChatRepository,
    private readonly cache: VideoRoomChatCacheService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
  ) {}

  async send(
    actor: RoomActor,
    roomId: string,
    dto: SendChatMessageInput,
    audit?: ChatAuditContext,
  ): Promise<VideoRoomMessage> {
    const content = dto.content.trim();
    const isStaff = actor.roles?.some((r: any) => r === 'ADMIN' || r === 'SUPER_ADMIN');
    const type =
      isStaff || dto.type === VideoRoomMessageType.SYSTEM
        ? VideoRoomMessageType.SYSTEM
        : (dto.type ?? VideoRoomMessageType.TEXT);
    const attachments = dto.attachments ?? [];

    // 1. Authorization + content bounds.
    const { room, settings } = await this.policy.assertCanSend(actor, roomId, {
      type,
      contentLength: content.length,
      attachmentCount: attachments.length,
    });

    // 2. Anti-abuse.
    await this.limiter.assertMaySend(roomId, actor.id, content, {
      rateMax: settings?.chatRateLimitPerMinute ?? 20,
      slowModeSeconds: settings?.slowModeSeconds ?? 0,
    });

    // 3. Reply target must exist and belong to this room. A DELETED parent is
    //    fine — the client renders a tombstone rather than losing the thread.
    if (dto.replyToId) await this.assertReplyTarget(roomId, dto.replyToId);

    // 4. Blocked-word scan: mask and continue, or reject. No auto-discipline.
    const finalContent = this.applyWordScan(content, roomId, actor.id);

    const cfg = loadVideoRoomChatConfig(this.config);

    // 5. Mentions.
    const resolved = await this.mentions.resolve(content, {
      roomId,
      ownerId: room.ownerId,
      senderId: actor.id,
      max: cfg.maxMentions,
    });

    // 6. Durable write.
    const message = await this.repo.createMessage({
      roomId,
      senderId: actor.id,
      type,
      content: finalContent,
      mentions: resolved.userIds,
      mentionScope: resolved.scope,
      replyToId: dto.replyToId ?? null,
      forwardedFromId: dto.forwardedFromId ?? null,
      ...(attachments.length > 0 ? { attachments: attachments as never } : {}),
    });

    // 7. Cache + fan-out.
    const payload = this.toPayload(message);
    await this.cache.pushRecent(roomId, payload);
    await this.bus.publish(new ChatMessageSentEvent({ ...payload, audit }));

    if (resolved.userIds.length > 0) {
      await this.bus.publish(
        new ChatMentionedEvent({
          roomId,
          messageId: message.id,
          senderId: actor.id,
          recipientIds: resolved.userIds,
          scope: resolved.scope,
        }),
      );
    }

    await this.limiter.applySlowMode(roomId, actor.id, settings?.slowModeSeconds ?? 0);
    return message;
  }

  /**
   * The wire shape every message-carrying event and response uses. Delegates to
   * the shared mapper — kept as a method because external callers hold a
   * reference to it.
   */
  toPayload(message: VideoRoomMessage): ChatMessagePayload {
    return toChatMessagePayload(message);
  }

  /**
   * Edit an existing message. The Redis buffer holds a stale copy, so it is
   * invalidated wholesale rather than surgically rewritten — a Redis list has no
   * addressable update, and refilling from Postgres is cheap and always correct.
   */
  async edit(
    actor: RoomActor,
    roomId: string,
    messageId: string,
    content: string,
    audit?: ChatAuditContext,
  ): Promise<VideoRoomMessage> {
    const message = await this.load(roomId, messageId);
    await this.policy.assertCanEdit(actor, roomId, message);

    const trimmed = content.trim();
    const updated = await this.repo.editMessage(messageId, trimmed);
    await this.cache.invalidateRecent(roomId);
    await this.bus.publish(
      new ChatMessageEditedEvent({
        roomId,
        messageId,
        editorId: actor.id,
        content: trimmed,
        editedAt: (updated.editedAt ?? new Date()).toISOString(),
        audit,
      }),
    );
    return updated;
  }

  /** Soft delete. Idempotent: a repeat call emits nothing and changes nothing. */
  async remove(
    actor: RoomActor,
    roomId: string,
    messageId: string,
    audit?: ChatAuditContext,
  ): Promise<void> {
    const message = await this.load(roomId, messageId);
    if (message.deletedAt) return;

    const { byModerator } = await this.policy.assertCanDelete(actor, roomId, message);
    await this.repo.softDeleteMessage(messageId, actor.id);
    await this.unpinIfPinned(roomId, messageId, actor.id);
    await this.cache.invalidateRecent(roomId);
    await this.bus.publish(
      new ChatMessageDeletedEvent({ roomId, messageId, deletedBy: actor.id, byModerator, audit }),
    );
  }

  /** The sender's own unsend. Idempotent, and withheld from everyone on read. */
  async recall(
    actor: RoomActor,
    roomId: string,
    messageId: string,
    audit?: ChatAuditContext,
  ): Promise<void> {
    const message = await this.load(roomId, messageId);
    if (message.recalledAt) return;

    await this.policy.assertCanRecall(actor, roomId, message);
    await this.repo.recallMessage(messageId);
    await this.unpinIfPinned(roomId, messageId, actor.id);
    await this.cache.invalidateRecent(roomId);
    await this.bus.publish(
      new ChatMessageRecalledEvent({ roomId, messageId, senderId: actor.id, audit }),
    );
  }

  private async load(roomId: string, messageId: string): Promise<VideoRoomMessage> {
    const message = await this.repo.findMessage(messageId);
    if (!message || message.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.MESSAGE_NOT_FOUND,
        'Message not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return message;
  }

  /** A withdrawn message must not stay pinned to the top of the room. */
  private async unpinIfPinned(roomId: string, messageId: string, actorId: string): Promise<void> {
    const pin = await this.repo.findActivePin(roomId, messageId);
    if (pin) await this.repo.deactivatePin(pin.id, actorId);
  }

  private async assertReplyTarget(roomId: string, replyToId: string): Promise<void> {
    const parent = await this.repo.findMessage(replyToId);
    if (!parent || parent.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_REPLY_TARGET_INVALID,
        'The message you are replying to does not exist in this room.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * MASK ⇒ store the masked text and continue. REJECT and ESCALATE both refuse
   * the message. VR-9 stops there: AR-4 escalates CRITICAL hits into auto-reports
   * and auto-mutes, but Moderation Actions is out of scope for this phase.
   */
  private applyWordScan(content: string, roomId: string, userId: string): string {
    const scan = this.words.scan(content);
    if (!scan.matched) return content;
    // A MASK hit still sends — handled, not rejected, so it is not an abuse
    // signal. Only the BLOCK path is counted.
    if (scan.action === BlockedWordAction.MASK) return scan.maskedText;
    // Fire-and-forget: this is the anti-abuse rejection path, so it must not
    // depend on the health of SPAM_DETECTED listeners. `emitAsync` propagates a
    // subscriber's thrown error (or an unbounded hang) right out of `publish`,
    // which would replace the intended BLOCKED_WORD exception with a 500 — or
    // block the rejection entirely. Publish, swallow and log any listener
    // failure, then throw regardless.
    void this.bus
      .publish(new ChatSpamDetectedEvent({ roomId, userId, kind: 'blocked_word' }))
      .catch((error: Error) =>
        this.logger.warn(`Spam signal publish failed for kind=blocked_word: ${error.message}`),
      );
    throw new BusinessException(
      ERROR_CODES.BLOCKED_WORD,
      'Your message was blocked by the community guidelines filter.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
