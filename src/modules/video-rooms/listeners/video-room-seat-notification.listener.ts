import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';
import {
  VIDEO_ROOM_SEAT_EVENTS,
  type SeatInvitationSentEvent,
  type SeatRequestResolvedEvent,
} from '../events/video-room-seat.events';
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import type { ViewerDemotedEvent, ViewerPromotedEvent } from '../events/video-room-viewer.events';
import { VideoRoomNotificationService } from '../services/video-room-notification.service';

/** Bridges seat-workflow + viewer events to notifications (VR-15). */
@Injectable()
export class VideoRoomSeatNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: VideoRoomNotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<SeatInvitationSentEvent>(VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT, (e) => {
      const p = e.payload;
      const kind = p.type === 'ROOM' ? K.ROOM_INVITATION : K.SEAT_INVITATION;
      return this.notifications.dispatch(kind, {
        roomId: p.roomId,
        targetUserIds: [p.inviteeUserId],
        actorId: p.inviterId,
        title: p.type === 'ROOM' ? 'Room invitation' : 'Seat invitation',
        body: 'You have been invited',
      });
    });

    this.bus.subscribe<SeatRequestResolvedEvent>(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, (e) => {
      const p = e.payload;
      if (p.status === 'ACCEPTED') {
        return this.notifications.dispatch(K.SEAT_APPROVAL, {
          roomId: p.roomId,
          targetUserIds: [p.userId],
          actorId: p.actorId ?? null,
          title: 'Seat approved',
          body: 'Your seat request was approved',
        });
      }
      if (p.status === 'REJECTED') {
        return this.notifications.dispatch(K.SEAT_REJECTION, {
          roomId: p.roomId,
          targetUserIds: [p.userId],
          actorId: p.actorId ?? null,
          title: 'Seat request declined',
          body: 'Your seat request was declined',
        });
      }
      return undefined; // CANCELLED/EXPIRED/PROMOTED/FAILED are not user-facing notifications
    });

    this.bus.subscribe<ViewerPromotedEvent>(VIDEO_ROOM_EVENTS.VIEWER_PROMOTED, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.VIEWER_PROMOTION, {
        roomId: p.roomId,
        targetUserIds: [p.userId],
        actorId: p.actorId,
        title: 'You are on a seat',
        body: 'You were promoted to a seat',
      });
    });

    this.bus.subscribe<ViewerDemotedEvent>(VIDEO_ROOM_EVENTS.VIEWER_DEMOTED, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.VIEWER_DEMOTION, {
        roomId: p.roomId,
        targetUserIds: [p.userId],
        actorId: p.actorId,
        title: 'Returned to audience',
        body: 'You were moved back to the audience',
      });
    });
  }
}
