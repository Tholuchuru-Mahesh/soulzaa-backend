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

  it('writes a durable row for a suspicious login', async () => {
    await suspicious();

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        type: NotificationType.SECURITY_NEW_LOGIN,
        entityType: 'device',
        entityId: 'dev-1',
      }),
    );
  });

  // DeviceService already enqueues the SECURITY push with excludeDeviceId, and
  // does it outside PushPolicy on purpose. Pushing again here would double-alert
  // on every suspicious login.
  it('does NOT push — DeviceService already sends the alert', async () => {
    await suspicious();

    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('keeps the reason, ip and country on the row', async () => {
    await suspicious();

    const input = notifications.create.mock.calls[0][0] as {
      data: { reason: string; ip: string | null; country: string | null };
    };
    expect(input.data).toEqual({ reason: 'new_device', ip: '1.2.3.4', country: 'IN' });
  });

  // Every login is not a security event. The device module already decides what
  // counts (new device / country change), and USER_LOGGED_IN hardcodes a null
  // deviceId at its publish site anyway.
  it('does not subscribe to USER_LOGGED_IN', () => {
    expect([...handlers.keys()]).not.toContain(AUTH_EVENTS.USER_LOGGED_IN);
  });

  it('dedupes repeated detections for the same device', async () => {
    await suspicious();

    expect(guard.once).toHaveBeenCalledWith(
      `login:${USER}:dev-1`,
      expect.any(Number),
      expect.any(Function),
    );
  });

  describe('password changed', () => {
    const changed = (viaReset = false) =>
      handlers.get(AUTH_EVENTS.USER_PASSWORD_CHANGED)!({
        payload: { userId: USER, viaReset },
      });

    it('both writes and pushes — nothing else covers it', async () => {
      await changed();

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: NotificationType.SECURITY_PASSWORD_CHANGED }),
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({ category: PUSH_CATEGORIES.SECURITY }),
      );
    });

    it('records whether the change came from the reset flow', async () => {
      await changed(true);

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ viaReset: true }) }),
      );
    });

    // SECURITY maps to null in CATEGORY_SWITCH and is never suppressed. Sending
    // no redactedBody keeps the real text, which is correct here: "your password
    // changed" is not a secret from the account's owner, and hiding it from the
    // lock screen would hide it from the person who needs to see it.
    it('does not redact the body', async () => {
      await changed();

      const intent = notifications.notify.mock.calls[0][1] as { redactedBody?: string };
      expect(intent.redactedBody).toBeUndefined();
    });
  });
});
