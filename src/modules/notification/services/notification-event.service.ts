import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

export interface NotificationEventPayload {
  notificationId: string;
  recipientId?: string;
  type?: string;
  priority?: string;
  title?: string;
  body?: string;
  channel?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class NotificationEventService {
  private readonly logger = new Logger(NotificationEventService.name);

  constructor(private readonly eventEmitter: EventEmitter2) {}

  emitNotificationCreated(payload: NotificationEventPayload): void {
    this.eventEmitter.emit('notification.created', payload);
    this.logger.log(`Event: notification.created — id: ${payload.notificationId}`);
  }

  emitNotificationSent(payload: NotificationEventPayload): void {
    this.eventEmitter.emit('notification.sent', payload);
    this.logger.log(
      `Event: notification.sent — id: ${payload.notificationId} via ${payload.channel}`,
    );
  }

  emitNotificationRead(payload: NotificationEventPayload): void {
    this.eventEmitter.emit('notification.read', payload);
    this.logger.log(`Event: notification.read — id: ${payload.notificationId}`);
  }

  emitNotificationFailed(payload: NotificationEventPayload): void {
    this.eventEmitter.emit('notification.failed', payload);
    this.logger.log(
      `Event: notification.failed — id: ${payload.notificationId} — err: ${payload.errorMessage}`,
    );
  }

  emitNotificationDeleted(payload: NotificationEventPayload): void {
    this.eventEmitter.emit('notification.deleted', payload);
    this.logger.log(`Event: notification.deleted — id: ${payload.notificationId}`);
  }

  emitAnnouncementPublished(payload: NotificationEventPayload): void {
    this.eventEmitter.emit('announcement.published', payload);
    this.logger.log(`Event: announcement.published — id: ${payload.notificationId}`);
  }
}
