import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoRoomMessage, VideoRoomMessagePin } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { LockService } from 'src/infra/redis/lock.service';
import { loadVideoRoomChatConfig } from '../config/video-room-chat.config';
import { videoRoomChatPinLockKey } from '../constants/video-room-chat.constants';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import {
  ChatMessagePinnedEvent,
  ChatMessageUnpinnedEvent,
  type ChatAuditContext,
} from '../events/video-room-chat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomChatRepository } from '../repositories/video-room-chat.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomsMetrics } from '../video-rooms.metrics';
import { VideoRoomChatCacheService } from './video-room-chat-cache.service';
import { VideoRoomPermissionService } from './video-room-permission.service';

/**
 * Pin / unpin, gated on the VR-1 `PIN_MESSAGES` permission that has sat unused
 * in the matrix since VR-1. Every mutation runs under a per-room lock so the pin
 * cap cannot be raced by two moderators pinning simultaneously — the check and
 * the insert must be atomic together, not merely individually correct.
 */
@Injectable()
export class VideoRoomChatPinService {
  private readonly logger = new Logger(VideoRoomChatPinService.name);

  constructor(
    private readonly permissions: VideoRoomPermissionService,
    private readonly rooms: VideoRoomsRepository,
    private readonly repo: VideoRoomChatRepository,
    private readonly cache: VideoRoomChatCacheService,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
    private readonly metrics: VideoRoomsMetrics,
  ) {}

  async pin(
    actor: RoomActor,
    roomId: string,
    messageId: string,
    audit?: ChatAuditContext,
  ): Promise<VideoRoomMessagePin> {
    const room = await this.loadRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.PIN_MESSAGES);
    const { maxPins } = loadVideoRoomChatConfig(this.config);

    return this.locks.withLock(videoRoomChatPinLockKey(roomId), async () => {
      const message = await this.repo.findMessage(messageId);
      if (!message || message.roomId !== roomId || message.deletedAt || message.recalledAt) {
        throw new BusinessException(
          ERROR_CODES.MESSAGE_NOT_FOUND,
          'Message not found.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (await this.repo.findActivePin(roomId, messageId)) {
        throw new BusinessException(
          ERROR_CODES.ALREADY_PINNED,
          'That message is already pinned.',
          HttpStatus.CONFLICT,
        );
      }
      if ((await this.repo.countActivePins(roomId)) >= maxPins) {
        throw new BusinessException(
          ERROR_CODES.PIN_LIMIT_REACHED,
          `A room may have at most ${maxPins} pinned messages.`,
          HttpStatus.CONFLICT,
        );
      }

      const pin = await this.repo.createPin({ roomId, messageId, pinnedBy: actor.id });
      await this.refreshPinCache(roomId);
      await this.bus.publish(
        new ChatMessagePinnedEvent({ roomId, messageId, pinnedBy: actor.id, audit }),
      );
      return pin;
    });
  }

  async unpin(
    actor: RoomActor,
    roomId: string,
    messageId: string,
    audit?: ChatAuditContext,
  ): Promise<void> {
    const room = await this.loadRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.PIN_MESSAGES);

    await this.locks.withLock(videoRoomChatPinLockKey(roomId), async () => {
      const pin = await this.repo.findActivePin(roomId, messageId);
      if (!pin) {
        throw new BusinessException(
          ERROR_CODES.PIN_NOT_FOUND,
          'That message is not pinned.',
          HttpStatus.NOT_FOUND,
        );
      }
      await this.repo.deactivatePin(pin.id, actor.id);
      await this.refreshPinCache(roomId);
      await this.bus.publish(
        new ChatMessageUnpinnedEvent({ roomId, messageId, unpinnedBy: actor.id, audit }),
      );
    });
  }

  /** Pinned messages, hydrated in ONE batched query (AR-4 loops per pin). */
  async listPinned(roomId: string): Promise<VideoRoomMessage[]> {
    const pins = await this.repo.listActivePins(roomId);
    return this.repo.listMessagesByIds(pins.map((p) => p.messageId));
  }

  private async refreshPinCache(roomId: string): Promise<void> {
    const pins = await this.repo.listActivePins(roomId);
    await this.cache.setPins(
      roomId,
      pins.map((p) => p.messageId),
    );

    // VR-9.2 (G3). Guarded because the pin row is ALREADY committed by the time
    // we get here — a metrics query must never fail an operation that has
    // already succeeded.
    try {
      this.metrics.setPinnedMessages(await this.repo.countAllActivePins());
    } catch (error) {
      this.logger.warn(`Pinned-message gauge refresh failed: ${(error as Error).message}`);
    }
  }

  private async loadRoom(roomId: string) {
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        'Room not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return room;
  }
}
