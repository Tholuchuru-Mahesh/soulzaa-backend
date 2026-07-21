import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoRoomMessage } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { loadVideoRoomChatConfig } from '../config/video-room-chat.config';
import { videoRoomChatCursorKey } from '../constants/video-room-chat.constants';
import { ChatMessageDeliveredEvent, ChatMessageReadEvent } from '../events/video-room-chat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomChatRepository } from '../repositories/video-room-chat.repository';
import { VideoRoomChatPolicyService } from './video-room-chat-policy.service';

/**
 * Read receipts as a HIGH-WATER MARK, one row per (room, user) — never one row
 * per (message, user). A 10k-viewer room at 500 msg/min would generate 5M receipt
 * rows a minute under the per-message shape; here it generates 10k rows total,
 * updated in place. The reader list is derived, not stored:
 *   readers(M) = cursors whose lastReadAt >= M.createdAt
 *
 * Two properties make this safe on a lossy mobile connection: the cursor only
 * ever moves FORWARD (an out-of-order receipt is dropped, not applied), and
 * repeated receipts are throttled through a short Redis NX window so a chatty
 * client cannot turn scroll events into a write storm.
 */
@Injectable()
export class VideoRoomChatReceiptService {
  constructor(
    private readonly repo: VideoRoomChatRepository,
    private readonly policy: VideoRoomChatPolicyService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
  ) {}

  async markDelivered(actor: RoomActor, roomId: string, messageId: string): Promise<void> {
    const message = await this.prepare(actor, roomId, messageId, 'delivered');
    if (!message) return;

    await this.repo.upsertCursor({
      roomId,
      userId: actor.id,
      deliveredMessageId: messageId,
      deliveredAt: message.createdAt,
    });
    await this.bus.publish(
      new ChatMessageDeliveredEvent({
        roomId,
        userId: actor.id,
        messageId,
        at: message.createdAt.toISOString(),
      }),
    );
  }

  async markRead(actor: RoomActor, roomId: string, messageId: string): Promise<void> {
    const message = await this.prepare(actor, roomId, messageId, 'read');
    if (!message) return;

    const cursor = await this.repo.findCursor(roomId, actor.id);
    // Monotonic: a mark that would move the cursor backwards is discarded.
    if (cursor?.lastReadAt && cursor.lastReadAt >= message.createdAt) return;

    await this.repo.upsertCursor({
      roomId,
      userId: actor.id,
      readMessageId: messageId,
      readAt: message.createdAt,
    });
    await this.bus.publish(
      new ChatMessageReadEvent({
        roomId,
        userId: actor.id,
        messageId,
        at: message.createdAt.toISOString(),
      }),
    );
  }

  /** Who has read at least as far as this message. */
  async readers(
    actor: RoomActor,
    roomId: string,
    messageId: string,
  ): Promise<{ userIds: string[] }> {
    await this.policy.assertActiveMember(roomId, actor.id);
    const message = await this.load(roomId, messageId);
    const cursors = await this.repo.listReaders(roomId, message.createdAt);
    return { userIds: cursors.map((c) => c.userId) };
  }

  /**
   * Shared preamble: membership, message lookup, and the throttle claim.
   * Returns null when the throttle rejects, meaning the caller should no-op.
   */
  private async prepare(
    actor: RoomActor,
    roomId: string,
    messageId: string,
    kind: 'read' | 'delivered',
  ): Promise<VideoRoomMessage | null> {
    await this.policy.assertActiveMember(roomId, actor.id);
    const message = await this.load(roomId, messageId);

    const { receiptThrottleMs } = loadVideoRoomChatConfig(this.config);
    const claimed = await this.redis.set(
      `${videoRoomChatCursorKey(roomId, actor.id)}:${kind}`,
      messageId,
      'PX',
      receiptThrottleMs,
      'NX',
    );
    return claimed === null ? null : message;
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
}
