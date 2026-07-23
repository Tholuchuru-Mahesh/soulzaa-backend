import { HttpStatus, Injectable } from '@nestjs/common';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPermissionService } from './video-room-permission.service';
import { VideoRoomNotificationService } from './video-room-notification.service';

/**
 * VR-15 — owner/admin/mod broadcast of a SYSTEM notification to a room's members.
 * The single producer for the SYSTEM notification kind. Distinct from chat
 * announcements (ANNOUNCEMENT kind); this is the `systemEvents`-gated channel.
 */
@Injectable()
export class VideoRoomSystemNotificationService {
  constructor(
    private readonly permissions: VideoRoomPermissionService,
    private readonly rooms: VideoRoomsRepository,
    private readonly notifications: VideoRoomNotificationService,
  ) {}

  async broadcast(
    actor: RoomActor,
    roomId: string,
    dto: { title: string; body: string },
  ): Promise<void> {
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        'Room not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_ANNOUNCEMENTS);
    await this.notifications.dispatchSystem({
      roomId,
      audience: 'ROOM_MEMBERS',
      occurrenceId: `system:${roomId}:${Date.now()}`,
      title: dto.title,
      body: dto.body,
    });
  }
}
