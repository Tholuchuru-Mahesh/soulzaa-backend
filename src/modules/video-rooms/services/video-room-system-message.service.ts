import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoRoomMessageType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { loadVideoRoomChatConfig } from '../config/video-room-chat.config';
import {
  SYSTEM_MESSAGE_POLICY,
  SYSTEM_MESSAGE_UNKNOWN_SUBJECT,
} from '../constants/video-room-system-message.policy';
import { VIDEO_ROOM_SYSTEM_ACTOR_ID } from '../constants/video-room.constants';
import { ChatMessageStatus } from '../dto/chat/chat-message.view';
import { ChatMessageSentEvent, type ChatMessagePayload } from '../events/video-room-chat.events';
import { VideoRoomChatRepository } from '../repositories/video-room-chat.repository';
import { VideoRoomChatCacheService } from './video-room-chat-cache.service';
import { VideoRoomIdentityCache } from './video-room-identity-cache.service';
import { VideoRoomPresenceService } from './video-room-presence.service';

/**
 * Turns domain events into chat system messages, governed by
 * `SYSTEM_MESSAGE_POLICY`. An UNMAPPED kind emits nothing at all — the VR-8
 * lesson that silence always beats guessing at the right message.
 */
@Injectable()
export class VideoRoomSystemMessageService {
  constructor(
    private readonly repo: VideoRoomChatRepository,
    private readonly cache: VideoRoomChatCacheService,
    private readonly presence: VideoRoomPresenceService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
    private readonly identities: VideoRoomIdentityCache,
  ) {}

  async emit(kind: string, roomId: string, data: Record<string, unknown>): Promise<void> {
    const policy = SYSTEM_MESSAGE_POLICY[kind];
    if (!policy) return;

    let persist = policy.persist;

    if (policy.degradesWithRoomSize) {
      const cfg = loadVideoRoomChatConfig(this.config);
      const viewers = await this.presence.viewerCount(roomId);
      if (viewers > cfg.systemMessageSuppressAboveViewers) return;
      if (viewers > cfg.systemMessageBroadcastOnlyAboveViewers) persist = false;
    }

    const content = await this.render(policy.template, data);
    const subjectUserId = this.subjectOf(data);

    const payload = persist
      ? await this.persistRow(kind, roomId, content, data, subjectUserId)
      : this.ephemeralPayload(kind, roomId, content, subjectUserId);

    await this.bus.publish(new ChatMessageSentEvent(payload));
  }

  /**
   * Fill a policy template's `{name}` with the subject's display name.
   *
   * This is the substitution `SystemMessagePolicy` has always documented and
   * never had. Without it the templates were emitted verbatim, which is why
   * every room showed "A user joined the room." no matter who joined.
   *
   * Three sources, in order: the name the emitting event already resolved
   * (`name`/`displayName`, the join path resolves this itself), the handle it
   * carried (`username`), and finally the identity cache — the same Redis-backed
   * resolver the member list and seat requests use, so a payload that carries
   * no name at all still produces a real one for one cache hit.
   *
   * A subject that cannot be resolved yields the neutral word rather than a
   * dangling `{name}` or an invented identity. Templates with no placeholder
   * (`ROOM_LOCKED`, `ROOM_CLOSED`, …) skip all of this — including the lookup.
   */
  private async render(template: string, data: Record<string, unknown>): Promise<string> {
    if (!template.includes('{name}')) return template;

    const direct = this.firstUsableName([data.name, data.displayName, data.username]);
    if (direct) return template.replaceAll('{name}', direct);

    const userId = this.subjectOf(data);
    if (userId) {
      const identity = (await this.identities.resolve([userId]).catch(() => null))?.get(userId);
      const resolved = this.firstUsableName([identity?.displayName, identity?.username]);
      if (resolved) return template.replaceAll('{name}', resolved);
    }

    return template.replaceAll('{name}', SYSTEM_MESSAGE_UNKNOWN_SUBJECT);
  }

  /** The user a system message is ABOUT, if the event names one. */
  private subjectOf(data: Record<string, unknown>): string | undefined {
    for (const key of ['userId', 'targetUserId', 'subjectUserId', 'inviteeId'] as const) {
      const value = data[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return undefined;
  }

  /**
   * The first candidate that is an actual name.
   *
   * Rejects blanks, the legacy `User` placeholder, and anything email-shaped —
   * a room must never be shown a member's email address, and some profile rows
   * fall back to it when no username is set.
   */
  private firstUsableName(candidates: unknown[]): string | undefined {
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const value = candidate.trim();
      if (!value || value.toLowerCase() === 'user') continue;
      const at = value.indexOf('@');
      if (at > 0 && at === value.lastIndexOf('@') && !value.includes(' ')) {
        const domain = value.slice(at + 1);
        if (domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.')) continue;
      }
      return value;
    }
    return undefined;
  }

  /**
   * Free-text variant of `emit()` for content that isn't one of the fixed
   * `SYSTEM_MESSAGE_POLICY` templates — e.g. a moderator's own warning text.
   * Always persists (no room-size degradation — a moderator warning is not
   * presence churn).
   */
  async emitCustom(roomId: string, content: string, data: Record<string, unknown>): Promise<void> {
    const payload = await this.persistRow(
      'MODERATOR_WARNING',
      roomId,
      content,
      data,
      this.subjectOf(data),
    );
    await this.bus.publish(new ChatMessageSentEvent(payload));
  }

  private async persistRow(
    kind: string,
    roomId: string,
    content: string,
    data: Record<string, unknown>,
    subjectUserId?: string,
  ): Promise<ChatMessagePayload> {
    const message = await this.repo.createMessage({
      roomId,
      senderId: VIDEO_ROOM_SYSTEM_ACTOR_ID,
      type: VideoRoomMessageType.SYSTEM,
      content,
      mentions: [],
      metadata: { systemEvent: kind, ...data } as never,
    });
    const payload: ChatMessagePayload = {
      roomId,
      messageId: message.id,
      senderId: VIDEO_ROOM_SYSTEM_ACTOR_ID,
      type: VideoRoomMessageType.SYSTEM,
      content,
      status: ChatMessageStatus.SENT,
      mentions: [],
      mentionScope: null,
      replyToId: null,
      createdAt: message.createdAt.toISOString(),
      systemEvent: kind,
      subjectUserId,
    };
    await this.cache.pushRecent(roomId, payload);
    return payload;
  }

  /** Broadcast-only: no row, no id — clients render it and forget it. */
  private ephemeralPayload(
    kind: string,
    roomId: string,
    content: string,
    subjectUserId?: string,
  ): ChatMessagePayload {
    return {
      roomId,
      messageId: '',
      senderId: VIDEO_ROOM_SYSTEM_ACTOR_ID,
      type: VideoRoomMessageType.SYSTEM,
      content,
      status: ChatMessageStatus.SENT,
      mentions: [],
      mentionScope: null,
      replyToId: null,
      createdAt: new Date().toISOString(),
      systemEvent: kind,
      subjectUserId,
    };
  }
}
