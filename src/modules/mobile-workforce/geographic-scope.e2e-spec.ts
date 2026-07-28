import { ConfigService } from '@nestjs/config';
import { GeographicScopeResolver } from 'src/modules/authorization/services/geographic-scope-resolver.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
import { WorkforceScopeService } from './services/workforce-scope.service';

/** The migration bridge is a config flag; tests state which mode they exercise. */
const bridgeConfig = (enabled: boolean) =>
  ({ get: () => ({ scopeCountryBridge: enabled }) }) as unknown as ConfigService;

/**
 * The full scope workflow, wired with the real service graph and a stubbed data
 * layer: scope assignment → resolution → query filter.
 *
 * Each case is a visibility guarantee an operator depends on, so a regression
 * here means someone either loses their territory or sees another's.
 */
describe('geographic scope workflow', () => {
  const buildService = (scopeRows: unknown[], roleNames: string[]) => {
    const scopes = { getUserScopes: jest.fn().mockResolvedValue(scopeRows) };
    const roles = { getRoleNames: jest.fn().mockResolvedValue(roleNames) };
    return new WorkforceScopeService(
      scopes as unknown as GeographicScopeResolver,
      roles as unknown as RoleResolver,
      bridgeConfig(true),
    );
  };

  it('an Official scoped to a state sees that state, not the whole country', async () => {
    const service = buildService(
      [{ scopeType: 'STATE', stateId: 's-ka', countryId: 'c-in' }],
      ['OFFICIAL'],
    );

    await expect(service.userScopeFilter('official-1')).resolves.toEqual({
      OR: [{ stateId: 's-ka' }, { stateId: null, countryId: 'c-in' }],
    });
  });

  it('a Moderator scoped to a region sees only that region', async () => {
    const service = buildService([{ scopeType: 'REGION', regionId: 'r-blr' }], ['MODERATOR']);

    await expect(service.userScopeFilter('mod-1')).resolves.toEqual({
      OR: [{ regionId: 'r-blr' }],
    });
  });

  it('two officials in different states never share a predicate', async () => {
    const ka = buildService(
      [{ scopeType: 'STATE', stateId: 's-ka', countryId: 'c-in' }],
      ['OFFICIAL'],
    );
    const mh = buildService(
      [{ scopeType: 'STATE', stateId: 's-mh', countryId: 'c-in' }],
      ['OFFICIAL'],
    );

    const [a, b] = await Promise.all([ka.userScopeFilter('a'), mh.userScopeFilter('b')]);

    expect(a).not.toEqual(b);
    expect(JSON.stringify(a)).toContain('s-ka');
    expect(JSON.stringify(a)).not.toContain('s-mh');
  });

  it('an existing country assignment keeps working unchanged after migration', async () => {
    // Backward compatibility: a COUNTRY scope assigned before this change still
    // resolves to the same visibility it always had.
    const service = buildService(
      [{ scopeType: 'COUNTRY', countryId: 'c-in' }],
      ['COUNTRY_MANAGER'],
    );

    await expect(service.userScopeFilter('cm-1')).resolves.toEqual({
      OR: [{ countryId: 'c-in' }],
    });
  });

  it('platform staff remain unrestricted', async () => {
    const service = buildService([], ['ADMIN']);

    await expect(service.userScopeFilter('admin-1')).resolves.toEqual({});
  });

  it('an unscoped operational role sees nothing', async () => {
    const service = buildService([], ['MODERATOR']);

    await expect(service.userScopeFilter('mod-2')).resolves.toEqual({ OR: [] });
  });

  it('describes the exact scope for the console header', async () => {
    const service = buildService([{ scopeType: 'REGION', regionId: 'r-blr' }], ['MODERATOR']);

    await expect(service.describeScope('mod-1')).resolves.toEqual({
      isUnrestricted: false,
      predicates: [{ scopeType: 'REGION', targetId: 'r-blr' }],
    });
  });
});
