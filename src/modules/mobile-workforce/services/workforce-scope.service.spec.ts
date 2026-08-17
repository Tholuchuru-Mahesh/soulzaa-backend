import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { GeographicScopeResolver } from 'src/modules/authorization/services/geographic-scope-resolver.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
import { WorkforceScopeService } from './workforce-scope.service';

/** The migration bridge is a config flag; tests state which mode they exercise. */
const bridgeConfig = (enabled: boolean) =>
  ({ get: () => ({ scopeCountryBridge: enabled }) }) as unknown as ConfigService;

/** Unused by userScopeFilter/describeScope tests — only owner-resolving methods touch Prisma. */
const unusedPrisma = {} as unknown as PrismaService;

/**
 * Geographic scope decides what an operational role can see. Too wide leaks
 * another territory's users; too narrow leaves a manager unable to work.
 */
describe('WorkforceScopeService.userScopeFilter', () => {
  let service: WorkforceScopeService;

  const scopes = { getUserScopes: jest.fn() };
  const roles = { getRoleNames: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks resets calls but keeps implementations, so the default has
    // to be re-established here or a role set from one test leaks into the next.
    roles.getRoleNames.mockResolvedValue(['COUNTRY_MANAGER']);
    service = new WorkforceScopeService(
      scopes as unknown as GeographicScopeResolver,
      roles as unknown as RoleResolver,
      bridgeConfig(true),
      unusedPrisma,
    );
  });

  it('matches a state scope on stateId, and on its country for un-normalised users', async () => {
    scopes.getUserScopes.mockResolvedValue([
      { scopeType: 'STATE', stateId: 's-1', countryId: 'c-1' },
    ]);

    // The second clause is the migration bridge: a user with no stateId yet is
    // still visible to the official responsible for their country, so nobody
    // loses access while location data is being filled in.
    await expect(service.userScopeFilter('official-1')).resolves.toEqual({
      OR: [{ stateId: 's-1' }, { stateId: null, countryId: 'c-1' }],
    });
  });

  it('matches a country scope on countryId', async () => {
    scopes.getUserScopes.mockResolvedValue([{ scopeType: 'COUNTRY', countryId: 'c-1' }]);

    await expect(service.userScopeFilter('cm-1')).resolves.toEqual({
      OR: [{ countryId: 'c-1' }],
    });
  });

  it('unions several scopes', async () => {
    scopes.getUserScopes.mockResolvedValue([
      { scopeType: 'COUNTRY', countryId: 'c-1' },
      { scopeType: 'STATE', stateId: 's-9', countryId: 'c-9' },
    ]);

    await expect(service.userScopeFilter('cm-1')).resolves.toEqual({
      OR: [{ countryId: 'c-1' }, { stateId: 's-9' }, { stateId: null, countryId: 'c-9' }],
    });
  });

  it('de-duplicates identical predicates', async () => {
    scopes.getUserScopes.mockResolvedValue([
      { scopeType: 'COUNTRY', countryId: 'c-1' },
      { scopeType: 'COUNTRY', countryId: 'c-1' },
    ]);

    await expect(service.userScopeFilter('cm-1')).resolves.toEqual({
      OR: [{ countryId: 'c-1' }],
    });
  });

  it('returns an unrestricted filter for a GLOBAL scope', async () => {
    scopes.getUserScopes.mockResolvedValue([{ scopeType: 'GLOBAL' }]);

    await expect(service.userScopeFilter('bd-1')).resolves.toEqual({});
  });

  it('returns an unrestricted filter for platform staff', async () => {
    roles.getRoleNames.mockResolvedValue(['ADMIN']);
    scopes.getUserScopes.mockResolvedValue([{ scopeType: 'COUNTRY', countryId: 'c-1' }]);

    await expect(service.userScopeFilter('admin-1')).resolves.toEqual({});
  });

  it('matches nothing when no scope is assigned', async () => {
    scopes.getUserScopes.mockResolvedValue([]);

    // An empty OR matches no rows. Returning {} here would hand an unscoped
    // operator the entire platform.
    await expect(service.userScopeFilter('unscoped-1')).resolves.toEqual({ OR: [] });
  });

  it('ignores a scope row missing the id its type requires', async () => {
    scopes.getUserScopes.mockResolvedValue([{ scopeType: 'STATE', stateId: null }]);

    await expect(service.userScopeFilter('mod-1')).resolves.toEqual({ OR: [] });
  });

  describe('with the migration bridge switched off', () => {
    beforeEach(() => {
      roles.getRoleNames.mockResolvedValue(['OFFICIAL']);
      service = new WorkforceScopeService(
        scopes as unknown as GeographicScopeResolver,
        roles as unknown as RoleResolver,
        bridgeConfig(false),
        unusedPrisma,
      );
    });

    it('narrows a state scope to that state alone', async () => {
      scopes.getUserScopes.mockResolvedValue([
        { scopeType: 'STATE', stateId: 's-1', countryId: 'c-1' },
      ]);

      // Strict mode: only users actually assigned to the state. Safe once every
      // user carries a stateId; empties the console before then, which is why
      // the bridge defaults on.
      await expect(service.userScopeFilter('official-1')).resolves.toEqual({
        OR: [{ stateId: 's-1' }],
      });
    });

    it('leaves a country scope unchanged', async () => {
      scopes.getUserScopes.mockResolvedValue([{ scopeType: 'COUNTRY', countryId: 'c-1' }]);

      await expect(service.userScopeFilter('cm-1')).resolves.toEqual({
        OR: [{ countryId: 'c-1' }],
      });
    });
  });
});

describe('WorkforceScopeService.describeScope', () => {
  let service: WorkforceScopeService;
  const scopes = { getUserScopes: jest.fn() };
  const roles = { getRoleNames: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    roles.getRoleNames.mockResolvedValue(['OFFICIAL']);
    service = new WorkforceScopeService(
      scopes as unknown as GeographicScopeResolver,
      roles as unknown as RoleResolver,
      bridgeConfig(true),
      unusedPrisma,
    );
  });

  it('reports the exact predicates in force', async () => {
    scopes.getUserScopes.mockResolvedValue([{ scopeType: 'STATE', stateId: 's-1' }]);

    await expect(service.describeScope('official-1')).resolves.toEqual({
      isUnrestricted: false,
      predicates: [{ scopeType: 'STATE', targetId: 's-1' }],
    });
  });

  it('reports unrestricted for platform staff', async () => {
    roles.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);
    scopes.getUserScopes.mockResolvedValue([]);

    await expect(service.describeScope('sa-1')).resolves.toEqual({
      isUnrestricted: true,
      predicates: [],
    });
  });
});

/**
 * Owner-scope enforcement for a moderation action. Matching resolves the
 * resource owner's stateId/countryId (one User lookup) and checks it against
 * the moderator's scope clauses directly — no Region indirection, since
 * Moderator RoleScope rows stop at State.
 */
describe('WorkforceScopeService.assertModeratorInScope', () => {
  let service: WorkforceScopeService;
  const scopes = { getUserScopes: jest.fn() };
  const roles = { getRoleNames: jest.fn() };
  const prisma = { user: { findUnique: jest.fn() } };

  const makeService = (bridge = true) =>
    new WorkforceScopeService(
      scopes as unknown as GeographicScopeResolver,
      roles as unknown as RoleResolver,
      bridgeConfig(bridge),
      prisma as unknown as PrismaService,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    roles.getRoleNames.mockResolvedValue(['MODERATOR']);
    service = makeService();
  });

  it('permits when the target carries no owner at all (safety valve)', async () => {
    await expect(service.assertModeratorInScope('mod-1', null)).resolves.toBeUndefined();
    expect(scopes.getUserScopes).not.toHaveBeenCalled();
  });

  it('permits platform staff regardless of scope rows', async () => {
    roles.getRoleNames.mockResolvedValue(['ADMIN']);
    scopes.getUserScopes.mockResolvedValue([]);
    await expect(service.assertModeratorInScope('admin-1', 'owner-1')).resolves.toBeUndefined();
  });

  it('permits when the target owner cannot be resolved (safety valve, same as an unresolved target)', async () => {
    scopes.getUserScopes.mockResolvedValue([
      { scopeType: 'STATE', stateId: 's-1', countryId: 'c-1' },
    ]);
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.assertModeratorInScope('mod-1', 'owner-ghost')).resolves.toBeUndefined();
  });

  it('denies an operator with no scope assigned at all', async () => {
    scopes.getUserScopes.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue({ stateId: 's-1', countryId: 'c-1' });
    await expect(service.assertModeratorInScope('unscoped-1', 'owner-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  describe('STATE-scoped actor', () => {
    beforeEach(() => {
      roles.getRoleNames.mockResolvedValue(['OFFICIAL']);
      scopes.getUserScopes.mockResolvedValue([
        { scopeType: 'STATE', stateId: 's-ka', countryId: 'c-in' },
      ]);
    });

    it('permits an owner located inside their state', async () => {
      prisma.user.findUnique.mockResolvedValue({ stateId: 's-ka', countryId: 'c-in' });
      await expect(
        service.assertModeratorInScope('official-1', 'owner-blr'),
      ).resolves.toBeUndefined();
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'owner-blr' },
        select: { stateId: true, countryId: true },
      });
    });

    // With the migration bridge ON the state scope also carries a country
    // clause, so the clean deny is an owner outside both — see the bridge
    // tests below for the same-country case and the bridge-off case.
    it('denies an owner in another state', async () => {
      prisma.user.findUnique.mockResolvedValue({ stateId: 's-ny', countryId: 'c-us' });
      await expect(
        service.assertModeratorInScope('official-1', 'owner-nyc'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    // The bridge clause is `{ stateId: null, countryId }`. Its null stateId
    // must not match a real owner's stateId, but its countryId still may.
    it('does not let the migration-bridge clause widen state matching, but its country still matches', async () => {
      prisma.user.findUnique.mockResolvedValue({ stateId: 's-tn', countryId: 'c-us' });
      await expect(
        service.assertModeratorInScope('official-1', 'owner-nyc'),
      ).rejects.toBeInstanceOf(ForbiddenException);

      prisma.user.findUnique.mockResolvedValue({ stateId: 's-tn', countryId: 'c-in' });
      await expect(
        service.assertModeratorInScope('official-1', 'owner-chn'),
      ).resolves.toBeUndefined();
    });

    it('with the migration bridge off, a different state in the same country is denied', async () => {
      service = makeService(false);
      prisma.user.findUnique.mockResolvedValue({ stateId: 's-tn', countryId: 'c-in' });
      await expect(
        service.assertModeratorInScope('official-1', 'owner-chn'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('COUNTRY-scoped actor', () => {
    beforeEach(() => {
      roles.getRoleNames.mockResolvedValue(['COUNTRY_MANAGER']);
      scopes.getUserScopes.mockResolvedValue([{ scopeType: 'COUNTRY', countryId: 'c-in' }]);
    });

    it('permits an owner located anywhere inside their country', async () => {
      prisma.user.findUnique.mockResolvedValue({ stateId: 's-tn', countryId: 'c-in' });
      await expect(service.assertModeratorInScope('cm-1', 'owner-chn')).resolves.toBeUndefined();
    });

    it('denies an owner in a different country', async () => {
      prisma.user.findUnique.mockResolvedValue({ stateId: 's-ny', countryId: 'c-us' });
      await expect(service.assertModeratorInScope('cm-1', 'owner-nyc')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});

describe('WorkforceScopeService.resolveEscalationRecipients', () => {
  let service: WorkforceScopeService;
  const scopes = { getUserScopes: jest.fn() };
  const roles = { getRoleNames: jest.fn(), getUserIdsWithAnyRole: jest.fn() };
  const prisma = { roleScope: { findMany: jest.fn() }, user: { findUnique: jest.fn() } };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new WorkforceScopeService(
      scopes as unknown as GeographicScopeResolver,
      roles as unknown as RoleResolver,
      bridgeConfig(true),
      prisma as unknown as PrismaService,
    );
  });

  it('EMERGENCY notifies Admin directly, skipping territory resolution entirely', async () => {
    roles.getUserIdsWithAnyRole.mockResolvedValue(['admin-1', 'admin-2']);

    const recipients = await service.resolveEscalationRecipients('EMERGENCY', 'owner-1');

    expect(recipients).toEqual(['admin-1', 'admin-2']);
    expect(roles.getUserIdsWithAnyRole).toHaveBeenCalledWith(['ADMIN', 'SUPER_ADMIN']);
    expect(prisma.roleScope.findMany).not.toHaveBeenCalled();
  });

  it("HIGH notifies the Official(s) scoped to the owner's state", async () => {
    prisma.user.findUnique.mockResolvedValue({ stateId: 's-1', countryId: 'c-1' });
    prisma.roleScope.findMany.mockResolvedValue([
      { userRole: { userId: 'official-1' } },
      { userRole: { userId: 'official-1' } },
    ]);

    const recipients = await service.resolveEscalationRecipients('HIGH', 'owner-1');

    expect(recipients).toEqual(['official-1']);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'owner-1' },
      select: { stateId: true, countryId: true },
    });
    expect(prisma.roleScope.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ scopeType: 'GLOBAL' }, { scopeType: 'STATE', stateId: 's-1' }],
          userRole: { role: { name: 'OFFICIAL' }, suspendedAt: null },
        }),
      }),
    );
  });

  it("CRITICAL notifies the Country Manager(s) scoped to the owner's country", async () => {
    prisma.user.findUnique.mockResolvedValue({ stateId: 's-1', countryId: 'c-1' });
    prisma.roleScope.findMany.mockResolvedValue([{ userRole: { userId: 'cm-1' } }]);

    const recipients = await service.resolveEscalationRecipients('CRITICAL', 'owner-1');

    expect(recipients).toEqual(['cm-1']);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'owner-1' },
      select: { stateId: true, countryId: true },
    });
    expect(prisma.roleScope.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ scopeType: 'GLOBAL' }, { scopeType: 'COUNTRY', countryId: 'c-1' }],
          userRole: { role: { name: 'COUNTRY_MANAGER' }, suspendedAt: null },
        }),
      }),
    );
  });

  it('falls back to Admin when no one is scoped to an unstaffed territory', async () => {
    prisma.user.findUnique.mockResolvedValue({ stateId: 's-empty', countryId: 'c-x' });
    prisma.roleScope.findMany.mockResolvedValue([]);
    roles.getUserIdsWithAnyRole.mockResolvedValue(['admin-1']);

    const recipients = await service.resolveEscalationRecipients('HIGH', 'owner-empty');

    expect(recipients).toEqual(['admin-1']);
    expect(roles.getUserIdsWithAnyRole).toHaveBeenCalledWith(['ADMIN', 'SUPER_ADMIN']);
  });

  it('falls back to Admin for CRITICAL when the owner cannot be resolved', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.roleScope.findMany.mockResolvedValue([]);
    roles.getUserIdsWithAnyRole.mockResolvedValue(['admin-1']);

    const recipients = await service.resolveEscalationRecipients('CRITICAL', 'owner-orphan');

    expect(recipients).toEqual(['admin-1']);
    expect(prisma.roleScope.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: [{ scopeType: 'GLOBAL' }] }),
      }),
    );
  });
});
