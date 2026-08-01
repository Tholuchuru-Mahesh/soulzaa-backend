import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import {
  VIP_EVENTS,
  type VipCreatedEvent,
  type VipExpiredEvent,
  type VipExpiringEvent,
  type VipRenewedEvent,
} from 'src/modules/vip/events/vip.events';
import { GUARD_TTL } from '../constants/notification-guard.constants';
import { NotificationGuard } from '../services/notification-guard.service';
import { NotificationService } from '../services/notification.service';

/** The date part of an ISO timestamp — the bucket the expiry warning dedupes on. */
const dayKey = (d: Date): string => new Date(d).toISOString().slice(0, 10);

/**
 * VIP lifecycle notifications.
 *
 * `UPGRADED` is deliberately absent: the audio-rooms socket bridge already
 * handles that one (entrance effects and badge sync), and an upgrade is
 * something the user just did on purpose — they do not need to be told.
 *
 * `EXPIRING` and `EXPIRED` can only ever come from the expiry sweep
 * (`VipExpiryService`), because nothing happens when time passes.
 */
@Injectable()
export class VipNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: NotificationService,
    private readonly guard: NotificationGuard,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<VipCreatedEvent>(VIP_EVENTS.CREATED, (e) =>
      this.emit(
        e.payload.userId,
        `vip:created:${e.payload.userId}:${dayKey(e.payload.expiresAt)}`,
        {
          type: NotificationType.VIP_ACTIVATED,
          title: 'VIP activated',
          body: `Your VIP ${e.payload.level} membership is now active`,
          data: { level: e.payload.level, expiresAt: e.payload.expiresAt },
        },
      ),
    );

    this.bus.subscribe<VipRenewedEvent>(VIP_EVENTS.RENEWED, (e) =>
      this.emit(
        e.payload.userId,
        `vip:renewed:${e.payload.userId}:${dayKey(e.payload.expiresAt)}`,
        {
          type: NotificationType.VIP_RENEWED,
          title: 'VIP renewed',
          body: `Your VIP ${e.payload.level} membership has been renewed`,
          data: { level: e.payload.level, expiresAt: e.payload.expiresAt },
        },
      ),
    );

    this.bus.subscribe<VipExpiringEvent>(VIP_EVENTS.EXPIRING, (e) =>
      // Bucketed by the expiry date, not by "today": the sweep runs every day
      // across the whole window, and without this the user is warned each morning.
      this.emit(
        e.payload.userId,
        `vip-expiring:${e.payload.userId}:${dayKey(e.payload.expiresAt)}`,
        {
          type: NotificationType.VIP_EXPIRING,
          title: 'VIP expiring soon',
          body: `Your VIP expires in ${e.payload.daysRemaining} day${e.payload.daysRemaining === 1 ? '' : 's'} — renew to keep your benefits`,
          data: {
            level: e.payload.level,
            expiresAt: e.payload.expiresAt,
            daysRemaining: e.payload.daysRemaining,
          },
        },
        GUARD_TTL.VIP_WINDOW,
      ),
    );

    this.bus.subscribe<VipExpiredEvent>(VIP_EVENTS.EXPIRED, (e) =>
      this.emit(e.payload.userId, `vip:expired:${e.payload.userId}`, {
        type: NotificationType.VIP_EXPIRED,
        title: 'VIP expired',
        body: 'Your VIP membership has expired. Renew any time to restore your benefits.',
        data: { level: e.payload.level },
      }),
    );
  }

  private async emit(
    userId: string,
    dedupeKey: string,
    notice: {
      type: NotificationType;
      title: string;
      body: string;
      data: Record<string, unknown>;
    },
    ttlSeconds: number = GUARD_TTL.VIP_WINDOW,
  ): Promise<void> {
    await this.guard.once(dedupeKey, ttlSeconds, async () => {
      await this.notifications.create({
        userId,
        type: notice.type,
        entityType: 'vip_membership',
        entityId: null,
        data: notice.data,
      });

      await this.notifications.notify(userId, {
        category: PUSH_CATEGORIES.VIP,
        title: notice.title,
        body: notice.body,
        threadId: `vip_${userId}`,
        badge: 'unread',
        data: { type: 'vip', notificationType: notice.type },
      });
    });
  }
}
