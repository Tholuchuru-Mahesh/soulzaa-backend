import { ConfigService } from '@nestjs/config';
import { CacheService } from 'src/infra/redis/cache.service';
import { AuthorizationCacheService } from './authorization-cache.service';

/**
 * Permission/role/scope cache lifetime is an operational dial: it trades staleness
 * after a role change against database load, and differs between environments.
 */
describe('AuthorizationCacheService — TTL is configurable', () => {
  const build = (ttlSeconds: number) => {
    const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
    const config = { get: jest.fn().mockReturnValue({ cacheTtlSeconds: ttlSeconds }) };
    const service = new AuthorizationCacheService(
      cache as unknown as CacheService,
      config as unknown as ConfigService,
    );
    return { service, cache };
  };

  it('writes permissions with the configured TTL', async () => {
    const { service, cache } = build(900);

    await service.setCachedPermissions('u-1', ['wallet.view']);

    expect(cache.set).toHaveBeenCalledWith('rbac:perms:u-1', ['wallet.view'], 900);
  });

  it('writes roles with the configured TTL', async () => {
    const { service, cache } = build(45);

    await service.setCachedRoles('u-1', [{ roleName: 'ADMIN' }]);

    expect(cache.set).toHaveBeenCalledWith('rbac:roles:u-1', [{ roleName: 'ADMIN' }], 45);
  });

  it('writes scopes with the configured TTL', async () => {
    const { service, cache } = build(45);

    await service.setCachedScopes('u-1', [{ scopeType: 'COUNTRY' }]);

    expect(cache.set).toHaveBeenCalledWith('rbac:scopes:u-1', [{ scopeType: 'COUNTRY' }], 45);
  });
});
