import { NotificationType } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { AUTH_EVENTS } from 'src/modules/auth/events/auth.events';
import { DEVICE_EVENTS } from 'src/modules/device/events/device.events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import type { NotificationGuard } from '../services/notification-guard.service';
import type { NotificationService } from '../services/notification.service';
import { SecurityNotificationListener } from './security-notification.listener';

const USER = 'user-1';

type Handler = (e: { payload: Record<string, unknown> }) => Promise<void>;

describe('SecurityNotificationListener', () => {
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

    const listener = new SecurityNotificationListener(
      bus as unknown as IEventBus,
      notifications as unknown as NotificationService,
      guard as unknown as NotificationGuard,
    );
    listener.onModuleInit();

    handlers = new Map<string, Handler>(bus.subscribe.mock.calls as [string, Handler][]);
  });

  const suspicious = (overrides: Record<string, unknown> = {}) =>
    handlers.get(DEVICE_EVENTS.SUSPICIOUS_LOGIN)!({
      payload: {
        userId: USER,
        deviceId: 'dev-1',
        reason: 'new_device',
        ip: '1.2.3.4',
        country: 'IN',
        ...overrides,
      },
    });

  it('does not dispatch in-app notification for suspicious login', async () => {
    await suspicious();

    expect(notifications.create).not.toHaveBeenCalled();
  });

  // Push was already removed from here, and is also disabled in DeviceService.
  it('does NOT push on suspicious login', async () => {
    await suspicious();

    expect(notifications.notify).not.toHaveBeenCalled();
  });

  // Every login is not a security event. The device module already decides what
  // counts (new device / country change), and USER_LOGGED_IN hardcodes a null
  // deviceId at its publish site anyway.
  it('does not subscribe to USER_LOGGED_IN', () => {
    expect([...handlers.keys()]).not.toContain(AUTH_EVENTS.USER_LOGGED_IN);
  });

  describe('password changed', () => {
    const changed = (viaReset = false) =>
      handlers.get(AUTH_EVENTS.USER_PASSWORD_CHANGED)!({
        payload: { userId: USER, viaReset },
      });

    it('does not dispatch in-app or push notifications on password changed', async () => {
      await changed();

      expect(notifications.create).not.toHaveBeenCalled();
      expect(notifications.notify).not.toHaveBeenCalled();
    });
  });
});
