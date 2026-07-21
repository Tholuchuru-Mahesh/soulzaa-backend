import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_NAMESPACE, VIDEO_ROOM_SOCKET_EVENTS } from '../constants/video-room.constants';
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';

/**
 * Bridges VR-9 chat domain events on the EVENT_BUS to realtime
 * `video_room.chat_*` broadcasts in the `/video-room` namespace (cross-instance
 * via the Redis adapter). Chat services never touch sockets.
 *
 * Bus event → socket event is declared as an exhaustive MAP rather than derived,
 * so adding a bus event without deciding how it reaches clients is a visible
 * omission instead of a silent one (the VR-8 `REQUEST_RESOLUTION_EVENTS` lesson).
 */
const BROADCAST_EVENTS: Record<string, string> = {
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_MESSAGE_SENT,
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_EDITED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_MESSAGE_EDITED,
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_DELETED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_MESSAGE_DELETED,
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_RECALLED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_MESSAGE_RECALLED,
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_PINNED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_MESSAGE_PINNED,
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_UNPINNED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_MESSAGE_UNPINNED,
  [VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_ANNOUNCEMENT_CREATED,
  [VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_UPDATED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_ANNOUNCEMENT_UPDATED,
  [VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_DELETED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_ANNOUNCEMENT_DELETED,
  [VIDEO_ROOM_CHAT_EVENTS.TYPING_STARTED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_TYPING_STARTED,
  [VIDEO_ROOM_CHAT_EVENTS.TYPING_STOPPED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_TYPING_STOPPED,
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_DELIVERED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_MESSAGE_DELIVERED,
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_READ]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_MESSAGE_READ,
  [VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED]: VIDEO_ROOM_SOCKET_EVENTS.CHAT_MODE_CHANGED,
};

@Injectable()
export class VideoRoomChatSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    for (const [busEvent, socketEvent] of Object.entries(BROADCAST_EVENTS)) {
      // `subscribe`'s generic defaults to the base `DomainEvent<unknown>` — the
      // concrete chat event classes aren't imported here since one handler
      // covers all 14 broadcast events, so the payload is narrowed by hand.
      this.bus.subscribe(busEvent, (event) => {
        const payload = event.payload as Record<string, unknown>;
        const { roomId } = payload as { roomId: string };
        this.sockets.emitToNamespaceRoom(
          VIDEO_ROOM_NAMESPACE,
          roomId,
          socketEvent,
          this.strip(payload),
        );
      });
    }

    // Mentions are point-to-point: broadcasting would tell the whole room who
    // was mentioned, which is neither useful nor private.
    this.bus.subscribe(VIDEO_ROOM_CHAT_EVENTS.MENTIONED, (event) => {
      const payload = event.payload as { recipientIds: string[] } & Record<string, unknown>;
      const stripped = this.strip(payload);
      for (const userId of payload.recipientIds) {
        this.sockets.emitToUserEverywhere(
          userId,
          VIDEO_ROOM_SOCKET_EVENTS.CHAT_MENTIONED,
          stripped,
        );
      }
    });
  }

  /** The audit block is for the audit trail, never for other room members. */
  private strip(payload: Record<string, unknown>): Record<string, unknown> {
    const { audit: _audit, ...rest } = payload;
    return rest;
  }
}
