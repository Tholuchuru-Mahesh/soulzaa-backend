import { Injectable } from '@nestjs/common';
import { Notification, Prisma } from '@prisma/client';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import type {
  CreateNotificationInput,
  INotificationService,
  NotificationView,
} from '../interfaces/notification.interface';
import { NotificationRepository } from '../repositories/notification.repository';

/** In-app notification store + reads. Realtime delivery of the underlying events
 * is handled by each producer's socket layer; these rows are the durable center. */
@Injectable()
export class NotificationService implements INotificationService {
  constructor(private readonly repo: NotificationRepository) {}

  async create(input: CreateNotificationInput): Promise<NotificationView> {
    const row = await this.repo.create({
      userId: input.userId,
      type: input.type,
      actorId: input.actorId ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      data: (input.data as Prisma.InputJsonValue | undefined) ?? undefined,
    });
    return this.toView(row);
  }

  async list(userId: string, page: number, limit: number): Promise<Paginated<NotificationView>> {
    const { rows, total } = await this.repo.page(userId, (page - 1) * limit, limit);
    return buildPaginated(
      rows.map((r) => this.toView(r)),
      total,
      page,
      limit,
    );
  }

  markRead(userId: string, id: string): Promise<void> {
    return this.repo.markRead(userId, id);
  }

  markAllRead(userId: string): Promise<void> {
    return this.repo.markAllRead(userId);
  }

  unreadCount(userId: string): Promise<number> {
    return this.repo.unreadCount(userId);
  }

  private toView(n: Notification): NotificationView {
    return {
      id: n.id,
      type: n.type,
      actorId: n.actorId,
      entityType: n.entityType,
      entityId: n.entityId,
      data: n.data,
      read: n.readAt !== null,
      createdAt: n.createdAt,
    };
  }
}
