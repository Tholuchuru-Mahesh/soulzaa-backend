import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { VideoRoomAnnouncement, VideoRoomMessageType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import {
  ChatAnnouncementCreatedEvent,
  ChatAnnouncementDeletedEvent,
  ChatAnnouncementUpdatedEvent,
  type ChatAuditContext,
} from '../events/video-room-chat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomChatRepository } from '../repositories/video-room-chat.repository';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomChatPinService } from './video-room-chat-pin.service';
import { VideoRoomPermissionService } from './video-room-permission.service';

/**
 * Room announcements. `video_room_announcements` — built in VR-1 and unused until
 * now — stays the editable RECORD OF RECORD; every announcement is additionally
 * projected into the chat stream as an ANNOUNCEMENT-type message linked back via
 * `metadata.announcementId`, so it appears inline where the PRD says it should.
 *
 * The announcement row is always written FIRST. If the projection fails, the
 * announcement still exists and the loss is cosmetic — never the other way
 * round.
 */
@Injectable()
export class VideoRoomAnnouncementService {
  private readonly logger = new Logger(VideoRoomAnnouncementService.name);

  constructor(
    private readonly permissions: VideoRoomPermissionService,
    private readonly rooms: VideoRoomsRepository,
    private readonly announcements: VideoRoomEventsRepository,
    private readonly chat: VideoRoomChatRepository,
    private readonly pins: VideoRoomChatPinService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async create(
    actor: RoomActor,
    roomId: string,
    dto: { content: string; isPinned?: boolean },
    audit?: ChatAuditContext,
  ): Promise<VideoRoomAnnouncement> {
    await this.authorize(actor, roomId);
    await this.assertAnnouncementsAllowed(roomId);
    const content = dto.content.trim();

    const announcement = await this.announcements.createAnnouncement({
      roomId,
      authorId: actor.id,
      content,
      isPinned: dto.isPinned ?? false,
    });

    const message = await this.chat.createMessage({
      roomId,
      senderId: actor.id,
      type: VideoRoomMessageType.ANNOUNCEMENT,
      content,
      mentions: [],
      metadata: { announcementId: announcement.id },
    });

    if (dto.isPinned) await this.pins.pin(actor, roomId, message.id, audit);

    await this.bus.publish(
      new ChatAnnouncementCreatedEvent({
        roomId,
        announcementId: announcement.id,
        messageId: message.id,
        authorId: actor.id,
        content,
        isPinned: dto.isPinned ?? false,
        audit,
      }),
    );
    return announcement;
  }

  async update(
    actor: RoomActor,
    roomId: string,
    announcementId: string,
    dto: { content?: string; isPinned?: boolean },
    audit?: ChatAuditContext,
  ): Promise<VideoRoomAnnouncement> {
    await this.authorize(actor, roomId);
    await this.assertAnnouncementsAllowed(roomId);
    await this.assertExists(roomId, announcementId);

    const content = dto.content?.trim();
    const updated = await this.announcements.updateAnnouncement(
      announcementId,
      {
        ...(content !== undefined ? { content } : {}),
        ...(dto.isPinned !== undefined ? { isPinned: dto.isPinned } : {}),
      },
      actor.id,
    );

    const projection = await this.chat.findByAnnouncementId(roomId, announcementId);
    if (projection && content !== undefined) {
      await this.chat.editMessage(projection.id, content);
    }
    if (projection && dto.isPinned !== undefined) {
      await (
        dto.isPinned
          ? this.pins.pin(actor, roomId, projection.id, audit)
          : this.pins.unpin(actor, roomId, projection.id, audit)
      ).catch((error: Error) =>
        // Pin state is presentational; an already-pinned/not-pinned conflict
        // must not fail the announcement edit itself.
        this.logger.warn(`Announcement ${announcementId} pin sync skipped: ${error.message}`),
      );
    }

    await this.bus.publish(
      new ChatAnnouncementUpdatedEvent({
        roomId,
        announcementId,
        messageId: projection?.id ?? null,
        actorId: actor.id,
        content: updated.content,
        isPinned: updated.isPinned,
        audit,
      }),
    );
    return updated;
  }

  async remove(
    actor: RoomActor,
    roomId: string,
    announcementId: string,
    audit?: ChatAuditContext,
  ): Promise<void> {
    await this.authorize(actor, roomId);
    await this.assertExists(roomId, announcementId);

    await this.announcements.softDeleteAnnouncement(announcementId, actor.id);

    const projection = await this.chat.findByAnnouncementId(roomId, announcementId);
    if (projection) await this.chat.softDeleteMessage(projection.id, actor.id);

    await this.bus.publish(
      new ChatAnnouncementDeletedEvent({
        roomId,
        announcementId,
        messageId: projection?.id ?? null,
        actorId: actor.id,
        audit,
      }),
    );
  }

  list(roomId: string): Promise<VideoRoomAnnouncement[]> {
    return this.announcements.listAnnouncements(roomId);
  }

  private async authorize(actor: RoomActor, roomId: string): Promise<void> {
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        'Room not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_ANNOUNCEMENTS);
  }

  /**
   * VR-17: room policy gate for `create`/`update` only. Deliberately NOT applied
   * to `remove` — turning announcements off must not trap the announcements
   * already posted; an owner still has to be able to clean them up. Also
   * deliberately no owner/admin bypass: whoever can flip the flag can simply
   * turn it back on.
   */
  private async assertAnnouncementsAllowed(roomId: string): Promise<void> {
    const settings = await this.rooms.getSettings(roomId);
    if (settings && !settings.allowAnnouncements) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'Announcements are disabled in this room.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async assertExists(roomId: string, announcementId: string): Promise<void> {
    const all = await this.announcements.listAnnouncements(roomId);
    if (!all.some((a) => a.id === announcementId)) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_ANNOUNCEMENT_NOT_FOUND,
        'Announcement not found.',
        HttpStatus.NOT_FOUND,
      );
    }
  }
}
