import { ROLE_EVENTS } from 'src/modules/authorization/events/role.events';
import { OfficialBadgeSyncListener } from './official-badge-sync.listener';

describe('OfficialBadgeSyncListener', () => {
  const badges = { syncOfficialBadge: jest.fn() } as any;
  const handlers = new Map<string, (e: unknown) => unknown>();
  const bus = {
    publish: jest.fn(),
    subscribe: jest.fn((name: string, handler: (e: unknown) => unknown) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    }),
  } as any;

  const event = { payload: { userId: 'u-1', roleId: 'r-official', actorId: 'actor-1' } };

  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    new OfficialBadgeSyncListener(bus, badges).onModuleInit();
  });

  it('subscribes to both role-change events', () => {
    expect([...handlers.keys()].sort()).toEqual([ROLE_EVENTS.ASSIGNED, ROLE_EVENTS.REVOKED].sort());
  });

  it('resyncs the badge when a role is assigned', async () => {
    await handlers.get(ROLE_EVENTS.ASSIGNED)!(event);
    expect(badges.syncOfficialBadge).toHaveBeenCalledWith('u-1');
  });

  it('resyncs the badge when a role is revoked', async () => {
    await handlers.get(ROLE_EVENTS.REVOKED)!(event);
    expect(badges.syncOfficialBadge).toHaveBeenCalledWith('u-1');
  });
});
