import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { SOCKET_NAMESPACES } from 'src/common/constants/socket.constants';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_NOTIFICATION_SOCKET_EVENTS } from '../constants/video-room-notification.constants';
import {
  VIDEO_ROOM_CHAT_EVENTS,
  type ChatAnnouncementCreatedEvent,
} from '../events/video-room-chat.events';

/**
 * In-room live *notification banner* on /video-room (VR-15). Distinct from the
 * chat feature's own `VideoRoomChatSocketListener`, which relays
 * ANNOUNCEMENT_CREATED as a chat-feed item — this emits a separate notification
 * banner event (different name/UI surface), not a duplicate. Durable
 * notification.created / read / count continue to fan out on /notifications via
 * the existing NotificationSocketListener; gift/pk/treasure/seat/role in-room
 * events stay owned by their existing listeners.
 */
@Injectable()
export class VideoRoomNotificationSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<ChatAnnouncementCreatedEvent>(
      VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED,
      (e) => {
        const p = e.payload;
        this.sockets.emitToNamespaceRoom(
          SOCKET_NAMESPACES.VIDEO_ROOM,
          p.roomId,
          VIDEO_ROOM_NOTIFICATION_SOCKET_EVENTS.ANNOUNCEMENT,
          {
            announcementId: p.announcementId,
            messageId: p.messageId,
            authorId: p.authorId,
            content: p.content,
            isPinned: p.isPinned,
          },
        );
      },
    );
  }
}
