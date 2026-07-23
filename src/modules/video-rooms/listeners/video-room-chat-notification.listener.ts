import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';
import {
  VIDEO_ROOM_CHAT_EVENTS,
  type ChatAnnouncementCreatedEvent,
  type ChatMentionedEvent,
} from '../events/video-room-chat.events';
import { VideoRoomNotificationService } from '../services/video-room-notification.service';

/** Bridges chat announcement + mention events to durable notifications (VR-15). */
@Injectable()
export class VideoRoomChatNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: VideoRoomNotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<ChatAnnouncementCreatedEvent>(
      VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED,
      (e) => {
        const p = e.payload;
        return this.notifications.dispatch(K.ANNOUNCEMENT, {
          roomId: p.roomId,
          actorId: p.authorId,
          occurrenceId: `${p.roomId}:${e.eventId}`,
          title: 'Announcement',
          body: p.content,
          data: { announcementId: p.announcementId },
        });
      },
    );

    this.bus.subscribe<ChatMentionedEvent>(VIDEO_ROOM_CHAT_EVENTS.MENTIONED, (e) => {
      const p = e.payload;
      if (p.recipientIds.length === 0) return undefined;
      return this.notifications.dispatch(K.MENTION, {
        roomId: p.roomId,
        targetUserIds: p.recipientIds,
        actorId: p.senderId,
        title: 'You were mentioned',
        body: 'You were mentioned in a room',
        data: { messageId: p.messageId },
      });
    });
  }
}
