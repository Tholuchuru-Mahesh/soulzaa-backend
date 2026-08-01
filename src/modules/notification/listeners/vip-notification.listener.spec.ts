import { NotificationType } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import { VIP_EVENTS } from 'src/modules/vip/events/vip.events';
import type { NotificationGuard } from '../services/notification-guard.service';
import type { NotificationService } from '../services/notification.service';
import { VipNotificationListener } from './vip-notification.listener';

const USER = 'user-1';
const EXPIRES = new Date('2026-09-01T00:00:00.000Z');

type Handler = (e: { payload: Record<string, unknown> }) => Promise<void>;

describe('VipNotificationListener', () => {
  let bus: { publish: jest.Mock; subscribe: jest.Mock };
  let notifications: { create: jest.Mock; notify: jest.Mock };
  let guard: { once: jest.Mock };
  let handlers: Map<string, Handler>;

  beforeEach(() => {
    bus = { publish: jest.fn(), subscribe: jest.fn() };
    notifications = {
      create: jest.fn().mockResolvedValue(undefined),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    guard = {
      once: jest.fn((_key: string, _ttl: number, fn: () => Promise<unknown>) => fn()),
    };

    const listener = new VipNotificationListener(
      bus as unknown as IEventBus,
      notifications as unknown as NotificationService,
      guard as unknown as NotificationGuard,
    );
    listener.onModuleInit();

    handlers = new Map<string, Handler>(bus.subscribe.mock.calls as [string, Handler][]);
  });

  it.each([
    [VIP_EVENTS.CREATED, NotificationType.VIP_ACTIVATED],
    [VIP_EVENTS.RENEWED, NotificationType.VIP_RENEWED],
    [VIP_EVENTS.EXPIRED, NotificationType.VIP_EXPIRED],
  ])('maps %s to the right notification type', async (event, type) => {
    await handlers.get(event)!({
      payload: { userId: USER, level: 3, expiresAt: EXPIRES },
    });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, type, entityType: 'vip_membership' }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ category: PUSH_CATEGORIES.VIP }),
    );
  });

  it('maps EXPIRING and names the days remaining in the body', async () => {
    await handlers.get(VIP_EVENTS.EXPIRING)!({
      payload: { userId: USER, level: 3, expiresAt: EXPIRES, daysRemaining: 3 },
    });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationType.VIP_EXPIRING }),
    );

    const intent = notifications.notify.mock.calls[0][1] as { body: string };
    expect(intent.body).toContain('3');
  });

  // The sweep runs daily across a multi-day window, so without a date-bucketed
  // key the same user would be warned every single morning until they renew.
  it('dedupes the expiring warning per user per expiry date', async () => {
    await handlers.get(VIP_EVENTS.EXPIRING)!({
      payload: { userId: USER, level: 3, expiresAt: EXPIRES, daysRemaining: 3 },
    });

    expect(guard.once).toHaveBeenCalledWith(
      `vip-expiring:${USER}:2026-09-01`,
      expect.any(Number),
      expect.any(Function),
    );
  });

  it('does not subscribe to UPGRADED — the audio-rooms bridge owns that', () => {
    expect([...handlers.keys()]).not.toContain(VIP_EVENTS.UPGRADED);
  });
});
