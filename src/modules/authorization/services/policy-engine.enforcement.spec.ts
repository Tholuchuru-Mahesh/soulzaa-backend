import { PolicyEngineService, RoleRankPolicyRule } from './policy-engine.service';

/**
 * Rank enforcement must not depend on an allow-list of "punitive" action codes.
 * Any action that declares a target is subject to it, so a new privileged action
 * is protected the day it is written rather than the day someone remembers to
 * register it. Callers that need no rank check simply omit targetRoles.
 */
describe('RoleRankPolicyRule — rank applies to any targeted action', () => {
  let engine: PolicyEngineService;

  beforeEach(() => {
    engine = new PolicyEngineService(new RoleRankPolicyRule());
    engine.onModuleInit();
  });

  const evaluate = (over: Partial<Parameters<PolicyEngineService['evaluate']>[0]>) =>
    engine.evaluate({
      actorUserId: 'actor',
      actorRoles: ['ADMIN'],
      action: 'user.suspend',
      targetUserId: 'target',
      targetRoles: ['MODERATOR'],
      ...over,
    });

  it.each([
    'user.suspend',
    'user.lock',
    'user.status.suspend',
    'user.session.force_logout',
    'user.role.assign',
    'user.role.remove',
  ])('denies a lower-ranked actor for action %s', async (action) => {
    await expect(
      evaluate({ action, actorRoles: ['MODERATOR'], targetRoles: ['ADMIN'] }),
    ).resolves.toBe(false);
  });

  it('denies an actor acting on a peer of equal rank', async () => {
    await expect(evaluate({ actorRoles: ['ADMIN'], targetRoles: ['ADMIN'] })).resolves.toBe(false);
  });

  it('allows a higher-ranked actor', async () => {
    await expect(evaluate({ actorRoles: ['ADMIN'], targetRoles: ['MODERATOR'] })).resolves.toBe(
      true,
    );
  });

  it('lets SUPER_ADMIN act on anyone', async () => {
    await expect(evaluate({ actorRoles: ['SUPER_ADMIN'], targetRoles: ['ADMIN'] })).resolves.toBe(
      true,
    );
  });

  it('denies an actor holding no roles at all', async () => {
    await expect(evaluate({ actorRoles: [], targetRoles: ['USER'] })).resolves.toBe(false);
  });

  it('skips the rank check when the action declares no target', async () => {
    await expect(
      engine.evaluate({
        actorUserId: 'actor',
        actorRoles: ['USER'],
        action: 'room.create',
      }),
    ).resolves.toBe(true);
  });

  it('ranks an actor by their highest role, not their first', async () => {
    await expect(
      evaluate({ actorRoles: ['USER', 'ADMIN'], targetRoles: ['MODERATOR'] }),
    ).resolves.toBe(true);
  });
});
