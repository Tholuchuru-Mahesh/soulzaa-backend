import { NotificationType } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import type { IRoleSource } from 'src/common/interfaces/role-source.interface';
import { DEVICE_EVENTS } from 'src/modules/device/events/device.events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import type { NotificationService } from '../services/notification.service';
import { ModeratorDeviceChangeNotificationListener } from './moderator-device-change-notification.listener';

type Handler = (e: { payload: Record<string, unknown> }) => Promise<void>;

describe('ModeratorDeviceChangeNotificationListener', () => {
  let bus: { publish: jest.Mock; subscribe: jest.Mock };
  let roles: { getUserIdsWithAnyRole: jest.Mock };
  let notifications: { create: jest.Mock; notify: jest.Mock };
  let handlers: Map<string, Handler>;

  beforeEach(() => {
    bus = { publish: jest.fn(), subscribe: jest.fn() };
    roles = { getUserIdsWithAnyRole: jest.fn().mockResolvedValue(['admin-1', 'admin-2']) };
    notifications = {
      create: jest.fn().mockResolvedValue(undefined),
      notify: jest.fn().mockResolvedValue(undefined),
    };

    const listener = new ModeratorDeviceChangeNotificationListener(
      bus as unknown as IEventBus,
      roles as unknown as IRoleSource,
      notifications as unknown as NotificationService,
    );
    listener.onModuleInit();

    handlers = new Map<string, Handler>(bus.subscribe.mock.calls as [string, Handler][]);
  });

  const requested = (overrides: Record<string, unknown> = {}) =>
    handlers.get(DEVICE_EVENTS.MODERATOR_DEVICE_CHANGE_REQUESTED)!({
      payload: {
        requestId: 'req-1',
        moderatorId: 'mod-1',
        reason: 'Automatic: rejected login from unbound device',
        ...overrides,
      },
    });

  it('resolves every Admin and Super Admin to notify', async () => {
    await requested();

    expect(roles.getUserIdsWithAnyRole).toHaveBeenCalledWith(['ADMIN', 'SUPER_ADMIN']);
  });

  it('creates a durable row for each resolved admin', async () => {
    await requested();

    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        type: NotificationType.MODERATOR_DEVICE_CHANGE_REQUESTED,
        entityType: 'device_change_request',
        entityId: 'req-1',
      }),
    );
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-2' }),
    );
  });

  it('pushes a SECURITY-category alert to each resolved admin', async () => {
    await requested();

    expect(notifications.notify).toHaveBeenCalledWith(
      'admin-1',
      expect.objectContaining({ category: PUSH_CATEGORIES.SECURITY }),
    );
  });

  it('keeps the moderator id and reason on the row', async () => {
    await requested();

    const input = notifications.create.mock.calls[0][0] as {
      data: { moderatorId: string; reason: string };
    };
    expect(input.data).toEqual({
      moderatorId: 'mod-1',
      reason: 'Automatic: rejected login from unbound device',
    });
  });

  it('does nothing when no Admin/Super Admin accounts exist', async () => {
    roles.getUserIdsWithAnyRole.mockResolvedValue([]);

    await requested();

    expect(notifications.create).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});
