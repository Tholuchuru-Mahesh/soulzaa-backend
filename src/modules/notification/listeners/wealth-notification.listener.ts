import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import {
  WEALTH_EVENTS,
  type WealthDowngradedEvent,
  type WealthLevelUpEvent,
  type WealthMonthlyResetEvent,
  type WealthRewardAvailableEvent,
  type WealthRewardClaimedEvent,
} from 'src/modules/wealth/events/wealth.events';
import { GUARD_TTL } from '../constants/notification-guard.constants';
import { NotificationGuard } from '../services/notification-guard.service';
import { NotificationService } from '../services/notification.service';

/**
 * Wealth Level lifecycle notifications — replaces `VipNotificationListener`
 * for the new system. Every event here is genuinely one-shot (a level
 * crossed, a monthly rollover, a reward granted), so the dedupe key is keyed
 * on the event's own identity rather than a rolling date bucket like the old
 * VIP expiry-window notifications needed.
 */
@Injectable()
export class WealthNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: NotificationService,
    private readonly guard: NotificationGuard,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<WealthLevelUpEvent>(WEALTH_EVENTS.LEVEL_UP, (e) =>
      this.emit(
        e.payload.userId,
        `wealth:level_up:${e.payload.userId}:${e.payload.periodKey}:${e.payload.toLevel}`,
        {
          type: NotificationType.WEALTH_LEVEL_UP,
          title: 'Wealth Level up!',
          body: `You've reached level ${e.payload.toLevel}`,
          data: { fromLevel: e.payload.fromLevel, toLevel: e.payload.toLevel },
        },
      ),
    );

    this.bus.subscribe<WealthDowngradedEvent>(WEALTH_EVENTS.DOWNGRADED, (e) =>
      this.emit(e.payload.userId, `wealth:downgraded:${e.payload.userId}:${e.payload.periodKey}`, {
        type: NotificationType.WEALTH_LEVEL_DOWNGRADED,
        title: 'Wealth Level adjusted',
        body: `Your level moved from ${e.payload.fromLevel} to ${e.payload.toLevel} this month`,
        data: { fromLevel: e.payload.fromLevel, toLevel: e.payload.toLevel },
      }),
    );

    this.bus.subscribe<WealthMonthlyResetEvent>(WEALTH_EVENTS.MONTHLY_RESET, (e) =>
      this.emit(
        e.payload.userId,
        `wealth:monthly_reset:${e.payload.userId}:${e.payload.newPeriodKey}`,
        {
          type: NotificationType.WEALTH_MONTHLY_RESET,
          title: 'New Wealth Level month started',
          body: 'Your monthly EXP has reset — start earning toward your next level',
          data: { startingLevel: e.payload.startingLevel },
        },
      ),
    );

    this.bus.subscribe<WealthRewardAvailableEvent>(WEALTH_EVENTS.REWARD_AVAILABLE, (e) =>
      this.emit(
        e.payload.userId,
        `wealth:reward_available:${e.payload.userId}:${e.payload.rewardId}`,
        {
          type: NotificationType.WEALTH_REWARD_AVAILABLE,
          title: 'Wealth Level reward available',
          body: 'A new reward is waiting for you',
          data: { rewardId: e.payload.rewardId, level: e.payload.level },
        },
      ),
    );

    this.bus.subscribe<WealthRewardClaimedEvent>(WEALTH_EVENTS.REWARD_CLAIMED, (e) =>
      this.emit(
        e.payload.userId,
        `wealth:reward_claimed:${e.payload.userId}:${e.payload.rewardId}`,
        {
          type: NotificationType.WEALTH_REWARD_CLAIMED,
          title: 'Reward claimed',
          body: 'Your Wealth Level reward has been credited',
          data: { rewardId: e.payload.rewardId, level: e.payload.level },
        },
      ),
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
  ): Promise<void> {
    await this.guard.once(dedupeKey, GUARD_TTL.WEALTH_WINDOW, async () => {
      await this.notifications.create({
        userId,
        type: notice.type,
        entityType: 'wealth_level',
        entityId: null,
        data: notice.data,
      });

      await this.notifications.notify(userId, {
        category: PUSH_CATEGORIES.WEALTH,
        title: notice.title,
        body: notice.body,
        threadId: `wealth_${userId}`,
        badge: 'unread',
        data: { type: 'wealth', notificationType: notice.type },
      });
    });
  }
}
