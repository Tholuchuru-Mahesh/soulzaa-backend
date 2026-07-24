import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_NAMESPACE } from '../constants/video-room.constants';
import {
  AnalyticsUpdatedEvent,
  VIDEO_ROOM_ANALYTICS_EVENTS,
  VIDEO_ROOM_ANALYTICS_SOCKET_EVENTS,
} from '../events/video-room-analytics.events';

@Injectable()
export class VideoRoomAnalyticsSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<AnalyticsUpdatedEvent>(
      VIDEO_ROOM_ANALYTICS_EVENTS.ANALYTICS_UPDATED,
      (e) => {
        if (e.payload?.roomId) {
          this.sockets.emitToNamespaceRoom(
            VIDEO_ROOM_NAMESPACE,
            e.payload.roomId,
            VIDEO_ROOM_ANALYTICS_SOCKET_EVENTS.ROOM_ANALYTICS_UPDATED,
            e.payload.data,
          );
        } else {
          this.sockets.emitToNamespaceRoom(
            VIDEO_ROOM_NAMESPACE,
            'global',
            VIDEO_ROOM_ANALYTICS_SOCKET_EVENTS.ANALYTICS_UPDATED,
            e.payload.data,
          );
        }
      },
    );
  }
}
