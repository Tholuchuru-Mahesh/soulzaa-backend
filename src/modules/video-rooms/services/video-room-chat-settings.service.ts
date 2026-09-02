import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma, VideoRoomChatMode, VideoRoomSettings } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import type { UpdateChatSettingsDto } from '../dto/chat';
import { ChatAuditContext, ChatModeChangedEvent } from '../events/video-room-chat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPermissionService } from './video-room-permission.service';

/**
 * VR-9.1a: the write side of the chat settings surface VR-9 shipped a policy
 * matrix for but never gave a way to set. Owner-only (`MANAGE_ROOM` — room
 * settings are an admin-restricted action per the PRD).
 *
 * THE MIRROR is the point of this service: whenever `chatMode` is part of the
 * update, `allowViewerChat` is ALSO written in the same payload —
 * `(chatMode !== PARTICIPANTS_ONLY)` — so the deprecated column stays truthful
 * for any undiscovered consumer (mobile client, admin surface, cached settings
 * payload) instead of freezing stale. `VideoRoomChatPolicyService` remains the
 * only reader of `chatMode` for authorization; this service never reads
 * `allowViewerChat` and nothing here changes that policy service.
 */
@Injectable()
export class VideoRoomChatSettingsService {
  constructor(
    private readonly rooms: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async update(
    actor: RoomActor,
    roomId: string,
    dto: UpdateChatSettingsDto,
    audit?: ChatAuditContext,
  ): Promise<VideoRoomSettings> {
    const room = await this.loadRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_ROOM);

    const data: Prisma.VideoRoomSettingsUpdateInput = {};
    if (dto.allowChat !== undefined) data.allowChat = dto.allowChat;
    if (dto.chatMode !== undefined) {
      data.chatMode = dto.chatMode;
      // THE MIRROR — see the class doc comment.
      data.allowViewerChat = dto.chatMode !== VideoRoomChatMode.PARTICIPANTS_ONLY;
    }
    if (dto.slowModeSeconds !== undefined) data.slowModeSeconds = dto.slowModeSeconds;
    if (dto.chatMaxMessageLength !== undefined) {
      data.chatMaxMessageLength = dto.chatMaxMessageLength;
    }
    if (dto.chatMaxAttachments !== undefined) data.chatMaxAttachments = dto.chatMaxAttachments;
    if (dto.chatRateLimitPerMinute !== undefined) {
      data.chatRateLimitPerMinute = dto.chatRateLimitPerMinute;
    }

    if (Object.keys(data).length === 0) {
      // No-op patch: nothing to write, nothing to announce. The settings row is
      // guaranteed to exist — created transactionally alongside the room.
      return (await this.rooms.getSettings(roomId)) as VideoRoomSettings;
    }

    const settings = await this.rooms.updateSettings(roomId, data);

    if (
      dto.chatMode !== undefined ||
      dto.allowChat !== undefined ||
      dto.slowModeSeconds !== undefined ||
      // The client tunes its composer from this, so a change has to be
      // announced. Without this branch a room could lower its message ceiling
      // and every connected client would keep offering the old one until it
      // happened to refetch the room.
      dto.chatMaxMessageLength !== undefined
    ) {
      await this.bus.publish(
        new ChatModeChangedEvent({
          roomId,
          chatMode: settings.chatMode,
          allowChat: settings.allowChat,
          slowModeSeconds: settings.slowModeSeconds,
          chatMaxMessageLength: settings.chatMaxMessageLength,
          actorId: actor.id,
          audit,
        }),
      );
    }

    return settings;
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
