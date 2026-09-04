import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { GIFTS_SERVICE, type IGiftsService } from 'src/modules/gifts/interfaces/gifts.service.interface';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { GiftLockDisabledEvent, GiftLockEnabledEvent } from '../events/video-room.events';
import type { VideoRoomDetailView } from '../entities/video-room-detail.view';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomPermissionService } from './video-room-permission.service';
import { VideoRoomQueryService } from './video-room-query.service';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomLogAction } from '@prisma/client';

/**
 * Enable/disable a video room's gift-lock: a designated catalog gift required
 * to enter. Fresh code, independent of the removed password-lock service —
 * the only thing it shares with it is the LOCK_ROOM permission concept ("who
 * may lock this room"), not any lock logic.
 */
@Injectable()
export class VideoRoomGiftLockService {
  constructor(
    private readonly repo: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
    @Inject(GIFTS_SERVICE) private readonly gifts: IGiftsService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly query: VideoRoomQueryService,
  ) {}

  async enable(actor: RoomActor, roomId: string, giftId: string): Promise<VideoRoomDetailView> {
    const room = await this.getRoomOrThrow(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.LOCK_ROOM);

    const enabled = await this.gifts.isGiftEnabled(giftId);
    if (!enabled) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_CONFIG_INVALID,
        'The selected gift is not available in the catalog.',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.repo.updateRoom(
      roomId,
      { giftLockEnabled: true, requiredEntryGiftId: giftId },
      actor.id,
    );
    await this.repo.appendLog({
      roomId,
      actorId: actor.id,
      action: VideoRoomLogAction.GIFT_LOCK_ENABLED,
      metadata: { giftId },
    });
    await this.bus.publish(new GiftLockEnabledEvent({ roomId, actorId: actor.id, giftId }));
    await this.repo.clearCachedSnapshot(roomId);
    return this.query.getDetail(roomId);
  }

  async disable(actor: RoomActor, roomId: string): Promise<VideoRoomDetailView> {
    const room = await this.getRoomOrThrow(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.LOCK_ROOM);

    await this.repo.updateRoom(
      roomId,
      { giftLockEnabled: false, requiredEntryGiftId: null },
      actor.id,
    );
    await this.repo.appendLog({
      roomId,
      actorId: actor.id,
      action: VideoRoomLogAction.GIFT_LOCK_DISABLED,
    });
    await this.bus.publish(new GiftLockDisabledEvent({ roomId, actorId: actor.id }));
    await this.repo.clearCachedSnapshot(roomId);
    return this.query.getDetail(roomId);
  }

  private async getRoomOrThrow(roomId: string) {
    const room = await this.repo.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        `Video room ${roomId} was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }
    return room;
  }
}
