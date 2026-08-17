import type { IEventBus } from 'src/common/events';
import { DEVICE_EVENTS } from 'src/modules/device/events/device.events';
import type { ISessionService } from '../interfaces/session.interface';
import { ModeratorDeviceChangeListener } from './moderator-device-change.listener';

type Handler = (e: { payload: Record<string, unknown> }) => Promise<void>;

describe('ModeratorDeviceChangeListener', () => {
  let bus: { publish: jest.Mock; subscribe: jest.Mock };
  let sessions: { adminForceLogout: jest.Mock };
  let handlers: Map<string, Handler>;

  beforeEach(() => {
    bus = { publish: jest.fn(), subscribe: jest.fn() };
    sessions = { adminForceLogout: jest.fn().mockResolvedValue(undefined) };

    const listener = new ModeratorDeviceChangeListener(
      bus as unknown as IEventBus,
      sessions as unknown as ISessionService,
    );
    listener.onModuleInit();

    handlers = new Map<string, Handler>(bus.subscribe.mock.calls as [string, Handler][]);
  });

  it('force-logs-out every session on the old device when Admin approves a device change', async () => {
    await handlers.get(DEVICE_EVENTS.MODERATOR_DEVICE_CHANGE_APPROVED)!({
      payload: { requestId: 'req-1', moderatorId: 'mod-1', approvedBy: 'admin-1' },
    });

    expect(sessions.adminForceLogout).toHaveBeenCalledWith('mod-1', 'admin-1');
  });

  it('subscribes only to the device-change-approved event', () => {
    expect([...handlers.keys()]).toEqual([DEVICE_EVENTS.MODERATOR_DEVICE_CHANGE_APPROVED]);
  });
});
