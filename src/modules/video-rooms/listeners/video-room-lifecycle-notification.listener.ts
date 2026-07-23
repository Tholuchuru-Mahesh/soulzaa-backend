import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';
import {
  VIDEO_ROOM_EVENTS,
  type RoomClosedEvent,
  type RoomStartedEvent,
} from '../events/video-room.events';
import { VideoRoomNotificationService } from '../services/video-room-notification.service';

/** Bridges room lifecycle events to notifications (VR-15). */
@Injectable()
export class VideoRoomLifecycleNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: VideoRoomNotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<RoomStartedEvent>(VIDEO_ROOM_EVENTS.STARTED, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.ROOM_STARTED, {
        roomId: p.roomId,
        ownerId: p.ownerId,
        actorId: p.ownerId,
        occurrenceId: `${p.roomId}:${e.eventId}`,
        title: 'Live now',
        body: 'A creator you follow just went live',
      });
    });

    this.bus.subscribe<RoomClosedEvent>(VIDEO_ROOM_EVENTS.CLOSED, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.ROOM_CLOSED, {
        roomId: p.roomId,
        actorId: p.actorId,
        occurrenceId: `${p.roomId}:${e.eventId}`,
        title: 'Room closed',
        body: 'A room you were in has ended',
      });
    });
  }
}
