// src/modules/video-rooms/listeners/video-room-engagement-notification.listener.ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';
import {
  VIDEO_ROOM_TREASURE_EVENTS,
  type TreasureRewardDistributedEvent,
  type TreasureUnlockedEvent,
} from '../events/video-room-treasure.events';
import {
  VIDEO_ROOM_PK_EVENTS,
  type PkInvitationAcceptedEvent,
  type PkInvitationRejectedEvent,
  type PkInvitationSentEvent,
  type PkWinnerDeclaredEvent,
} from '../events/video-room-pk.events';
import { VideoRoomNotificationService } from '../services/video-room-notification.service';

/**
 * Bridges treasure + PK engagement events to notifications (VR-15).
 *
 * `PK_ACCEPTED` / `PK_REJECTION` notifications target the invitee here (they
 * get the follow-up). If product wants the *inviter* notified instead, the
 * accepted/rejected event payloads do not carry the inviter id — that would
 * require adding it at the emit site (additive follow-up), out of scope here.
 */
@Injectable()
export class VideoRoomEngagementNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: VideoRoomNotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<TreasureRewardDistributedEvent>(
      VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED,
      (e) => {
        const p = e.payload;
        return this.notifications.dispatch(K.TREASURE_REWARD, {
          roomId: p.roomId,
          targetUserIds: [p.userId],
          title: 'Treasure reward',
          body: `You received ${p.amount}`,
          data: { amount: String(p.amount) },
        });
      },
    );

    this.bus.subscribe<TreasureUnlockedEvent>(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.TREASURE_UNLOCKED, {
        roomId: p.roomId,
        occurrenceId: `${p.roomId}:${e.eventId}`,
        title: 'Treasure unlocked',
        body: 'A treasure box was unlocked in the room',
      });
    });

    this.bus.subscribe<PkInvitationSentEvent>(VIDEO_ROOM_PK_EVENTS.INVITATION_SENT, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.PK_INVITATION, {
        roomId: p.roomId,
        targetUserIds: [p.inviteeUserId],
        actorId: p.inviterUserId,
        title: 'PK invitation',
        body: 'You were challenged to a PK battle',
      });
    });

    this.bus.subscribe<PkInvitationAcceptedEvent>(VIDEO_ROOM_PK_EVENTS.INVITATION_ACCEPTED, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.PK_ACCEPTED, {
        roomId: p.roomId,
        targetUserIds: [p.inviteeUserId],
        title: 'PK accepted',
        body: 'Your PK invitation was accepted',
      });
    });

    this.bus.subscribe<PkInvitationRejectedEvent>(VIDEO_ROOM_PK_EVENTS.INVITATION_REJECTED, (e) => {
      const p = e.payload;
      return this.notifications.dispatch(K.PK_REJECTION, {
        roomId: p.roomId,
        targetUserIds: [p.inviteeUserId],
        title: 'PK declined',
        body: 'Your PK invitation was declined',
      });
    });

    this.bus.subscribe<PkWinnerDeclaredEvent>(VIDEO_ROOM_PK_EVENTS.WINNER_DECLARED, (e) => {
      const p = e.payload;
      if (p.winners.length === 0) return undefined;
      return this.notifications.dispatch(K.PK_WINNER, {
        roomId: p.roomId,
        targetUserIds: p.winners,
        title: 'PK winner',
        body: 'You won the PK battle',
      });
    });
  }
}
