import { ConfigService } from '@nestjs/config';
import { GeographicScopeResolver } from 'src/modules/authorization/services/geographic-scope-resolver.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
import { WorkforceScopeService } from './workforce-scope.service';

/** The migration bridge is a config flag; tests state which mode they exercise. */
const bridgeConfig = (enabled: boolean) =>
  ({ get: () => ({ scopeCountryBridge: enabled }) }) as unknown as ConfigService;

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
    );
  });

  it('matches a region scope on regionId exactly', async () => {
    scopes.getUserScopes.mockResolvedValue([{ scopeType: 'REGION', regionId: 'r-1' }]);

    await expect(service.userScopeFilter('mod-1')).resolves.toEqual({
      OR: [{ regionId: 'r-1' }],
    });
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
      { scopeType: 'REGION', regionId: 'r-9' },
    ]);

    await expect(service.userScopeFilter('cm-1')).resolves.toEqual({
      OR: [{ countryId: 'c-1' }, { regionId: 'r-9' }],
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
    scopes.getUserScopes.mockResolvedValue([{ scopeType: 'REGION', regionId: null }]);

    await expect(service.userScopeFilter('mod-1')).resolves.toEqual({ OR: [] });
  });

  describe('with the migration bridge switched off', () => {
    beforeEach(() => {
      roles.getRoleNames.mockResolvedValue(['OFFICIAL']);
      service = new WorkforceScopeService(
        scopes as unknown as GeographicScopeResolver,
        roles as unknown as RoleResolver,
        bridgeConfig(false),
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

    it('leaves country and region scopes unchanged', async () => {
      scopes.getUserScopes.mockResolvedValue([
        { scopeType: 'COUNTRY', countryId: 'c-1' },
        { scopeType: 'REGION', regionId: 'r-1' },
      ]);

      await expect(service.userScopeFilter('cm-1')).resolves.toEqual({
        OR: [{ countryId: 'c-1' }, { regionId: 'r-1' }],
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
