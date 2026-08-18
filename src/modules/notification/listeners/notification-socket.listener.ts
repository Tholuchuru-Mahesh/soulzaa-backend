import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { USER_ROOM_PREFIX } from 'src/common/constants/socket.constants';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import {
  NOTIFICATION_NAMESPACE,
  NOTIFICATION_SOCKET_EVENTS,
} from '../constants/notification.constants';
import {
  NOTIFICATION_EVENTS,
  type NotificationCreatedEvent,
  type NotificationPreferencesChangedEvent,
  type NotificationReadAllEvent,
  type NotificationReadEvent,
} from '../events/notification.events';
import {
  BACKPACK_EVENTS,
  BackpackItemEquippedEvent,
  BackpackItemUnequippedEvent,
} from 'src/modules/backpack/events/backpack.events';

/**
 * Bridges notification-centre events to the `/notifications` namespace.
 *
 * Every event goes to the owner's per-user room and nobody else's, which makes
 * the whole thing multi-device for free: reading a notification on a phone clears
 * the bell on the tablet, because both sockets are already in `user:<id>`.
 *
 * This listener is what lets the client stop polling `GET /notifications/unread-count`.
 * The badge arrives with the event that changed it, so the number and the list can
 * never disagree — which they always eventually do when the two are fetched apart.
 */
@Injectable()
export class NotificationSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<NotificationCreatedEvent>(NOTIFICATION_EVENTS.CREATED, (e) =>
      this.toUser(e.payload.userId, NOTIFICATION_SOCKET_EVENTS.NEW, {
        notification: e.payload.notification,
        unreadCount: e.payload.unreadCount,
      }),
    );

    this.bus.subscribe<NotificationReadEvent>(NOTIFICATION_EVENTS.READ, (e) =>
      this.toUser(e.payload.userId, NOTIFICATION_SOCKET_EVENTS.READ, {
        id: e.payload.notificationId,
        unreadCount: e.payload.unreadCount,
      }),
    );

    this.bus.subscribe<NotificationReadAllEvent>(NOTIFICATION_EVENTS.READ_ALL, (e) =>
      this.toUser(e.payload.userId, NOTIFICATION_SOCKET_EVENTS.READ_ALL, {
        unreadCount: e.payload.unreadCount,
      }),
    );

    this.bus.subscribe<NotificationPreferencesChangedEvent>(
      NOTIFICATION_EVENTS.PREFERENCES_CHANGED,
      (e) =>
        this.toUser(
          e.payload.userId,
          NOTIFICATION_SOCKET_EVENTS.PREFERENCES,
          e.payload.preferences,
        ),
    );

    this.bus.subscribe<BackpackItemEquippedEvent>(BACKPACK_EVENTS.EQUIPPED, async (e) => {
      const { userId } = e.payload;
      this.toUser(userId, 'backpack.item.equipped', e.payload);
      this.toUser(userId, 'user.profile_updated', { userId });
      this.sockets.emitToNamespaceRoom(
        '/chat',
        `${USER_ROOM_PREFIX}${userId}`,
        'user.profile_updated',
        { userId },
      );

      try {
        const rooms = await this.sockets.getUserRooms(userId);
        for (const roomId of rooms) {
          this.sockets.emitToNamespaceRoom('/audio-room', roomId, 'seat.updated', {
            roomId,
            userId,
            changed: ['frame'],
          });
          this.sockets.emitToNamespaceRoom('/video-room', roomId, 'video_room.seat_updated', {
            roomId,
            userId,
            changed: ['frame'],
          });
        }
      } catch {
        // Ignored defensively
      }
    });

    this.bus.subscribe<BackpackItemUnequippedEvent>(BACKPACK_EVENTS.UNEQUIPPED, async (e) => {
      const { userId } = e.payload;
      this.toUser(userId, 'backpack.item.unequipped', e.payload);
      this.toUser(userId, 'user.profile_updated', { userId });
      this.sockets.emitToNamespaceRoom(
        '/chat',
        `${USER_ROOM_PREFIX}${userId}`,
        'user.profile_updated',
        { userId },
      );

      try {
        const rooms = await this.sockets.getUserRooms(userId);
        for (const roomId of rooms) {
          this.sockets.emitToNamespaceRoom('/audio-room', roomId, 'seat.updated', {
            roomId,
            userId,
            changed: ['frame'],
          });
          this.sockets.emitToNamespaceRoom('/video-room', roomId, 'video_room.seat_updated', {
            roomId,
            userId,
            changed: ['frame'],
          });
        }
      } catch {
        // Ignored defensively
      }
    });
  }

  private toUser(userId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(
      NOTIFICATION_NAMESPACE,
      `${USER_ROOM_PREFIX}${userId}`,
      event,
      payload,
    );
  }
}
