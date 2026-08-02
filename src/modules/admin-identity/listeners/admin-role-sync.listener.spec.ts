import { ROLE_EVENTS } from 'src/modules/authorization/events/role.events';
import { AdminRoleSyncListener } from './admin-role-sync.listener';

describe('AdminRoleSyncListener', () => {
  const identity = { syncHiddenState: jest.fn() } as any;
  const handlers = new Map<string, (e: unknown) => unknown>();
  const bus = {
    publish: jest.fn(),
    subscribe: jest.fn((name: string, handler: (e: unknown) => unknown) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    }),
  } as any;

  const event = { payload: { userId: 'u-1', roleId: 'r-admin', actorId: 'actor-1' } };

  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    new AdminRoleSyncListener(bus, identity).onModuleInit();
  });

  it('subscribes to both role-change events', () => {
    expect([...handlers.keys()].sort()).toEqual([ROLE_EVENTS.ASSIGNED, ROLE_EVENTS.REVOKED].sort());
  });

  it('resyncs the subject when a role is assigned', async () => {
    await handlers.get(ROLE_EVENTS.ASSIGNED)!(event);
    expect(identity.syncHiddenState).toHaveBeenCalledWith('u-1');
  });

  it('resyncs the subject when a role is revoked', async () => {
    await handlers.get(ROLE_EVENTS.REVOKED)!(event);
    expect(identity.syncHiddenState).toHaveBeenCalledWith('u-1');
  });

  it('resyncs regardless of which role changed', async () => {
    // Unconditional by design: a non-hidden role change can still flip the
    // outcome (e.g. the last hidden role being replaced), and recomputing is
    // one cheap lookup versus a whole class of stale-flag bugs.
    await handlers.get(ROLE_EVENTS.ASSIGNED)!({
      payload: { userId: 'u-9', roleId: 'r-host', actorId: null },
    });
    expect(identity.syncHiddenState).toHaveBeenCalledWith('u-9');
  });
});
