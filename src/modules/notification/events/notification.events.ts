import { DomainEvent } from 'src/common/events';
import type {
  NotificationPreferenceView,
  NotificationView,
} from '../interfaces/notification.interface';

/**
 * Notification-centre events on the EVENT_BUS. The notification socket listener
 * bridges them to the `/notifications` namespace.
 *
 * They are published by the notification service itself rather than by the
 * producers upstream, because the row is what the client is being told about —
 * publishing before the write would let a client learn about a notification the
 * database does not have.
 */
export const NOTIFICATION_EVENTS = {
  CREATED: 'notification.created',
  READ: 'notification.read',
  READ_ALL: 'notification.read_all',
  PREFERENCES_CHANGED: 'notification.preferences_changed',
} as const;

/** Every event carries the fresh unread count — see NOTIFICATION_SOCKET_EVENTS. */
interface Owned {
  userId: string;
  unreadCount: number;
}

export class NotificationCreatedEvent extends DomainEvent<
  Owned & { notification: NotificationView }
> {
  readonly name = NOTIFICATION_EVENTS.CREATED;
}

export class NotificationReadEvent extends DomainEvent<Owned & { notificationId: string }> {
  readonly name = NOTIFICATION_EVENTS.READ;
}

export class NotificationReadAllEvent extends DomainEvent<Owned> {
  readonly name = NOTIFICATION_EVENTS.READ_ALL;
}

export class NotificationPreferencesChangedEvent extends DomainEvent<{
  userId: string;
  preferences: NotificationPreferenceView;
}> {
  readonly name = NOTIFICATION_EVENTS.PREFERENCES_CHANGED;
}
