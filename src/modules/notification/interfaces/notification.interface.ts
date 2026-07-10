import type { NotificationType } from '@prisma/client';

/**
 * Public contract for the notification module. Other modules never write to the
 * notifications tables — they publish domain events, and this module's bridge
 * listener creates rows via NOTIFICATION_SERVICE.
 */
export const NOTIFICATION_SERVICE = Symbol('NOTIFICATION_SERVICE');

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  actorId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  data?: Record<string, unknown> | null;
}

export interface NotificationView {
  id: string;
  type: NotificationType;
  actorId: string | null;
  entityType: string | null;
  entityId: string | null;
  data: unknown;
  read: boolean;
  createdAt: Date;
}

export interface INotificationService {
  create(input: CreateNotificationInput): Promise<NotificationView>;
  markRead(userId: string, id: string): Promise<void>;
  markAllRead(userId: string): Promise<void>;
  unreadCount(userId: string): Promise<number>;
}
