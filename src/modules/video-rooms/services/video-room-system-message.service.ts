import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoRoomMessageType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { loadVideoRoomChatConfig } from '../config/video-room-chat.config';
import { SYSTEM_MESSAGE_POLICY } from '../constants/video-room-system-message.policy';
import { VIDEO_ROOM_SYSTEM_ACTOR_ID } from '../constants/video-room.constants';
import { ChatMessageSentEvent, type ChatMessagePayload } from '../events/video-room-chat.events';
import { VideoRoomChatRepository } from '../repositories/video-room-chat.repository';
import { VideoRoomChatCacheService } from './video-room-chat-cache.service';
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

    const payload = persist
      ? await this.persistRow(kind, roomId, policy.template, data)
      : this.ephemeralPayload(kind, roomId, policy.template, data);

    await this.bus.publish(new ChatMessageSentEvent(payload));
  }

  private async persistRow(
    kind: string,
    roomId: string,
    content: string,
    data: Record<string, unknown>,
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
      mentions: [],
      mentionScope: null,
      replyToId: null,
      createdAt: message.createdAt.toISOString(),
      systemEvent: kind,
    };
    await this.cache.pushRecent(roomId, payload);
    return payload;
  }

  /** Broadcast-only: no row, no id — clients render it and forget it. */
  private ephemeralPayload(
    kind: string,
    roomId: string,
    content: string,
    _data: Record<string, unknown>,
  ): ChatMessagePayload {
    return {
      roomId,
      messageId: '',
      senderId: VIDEO_ROOM_SYSTEM_ACTOR_ID,
      type: VideoRoomMessageType.SYSTEM,
      content,
      mentions: [],
      mentionScope: null,
      replyToId: null,
      createdAt: new Date().toISOString(),
      systemEvent: kind,
    };
  }
}
