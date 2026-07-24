import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RbacPermissionsGuard } from './rbac-permissions.guard';

const ctx = (user: unknown, _handler = {}, _class = {}) =>
  ({
    getHandler: () => _handler,
    getClass: () => _class,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as never;

describe('RbacPermissionsGuard (DB-backed — no stale-claim drift)', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let resolver: { checkUserHasPermissions: jest.Mock };
  let guard: RbacPermissionsGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    resolver = { checkUserHasPermissions: jest.fn() };
    guard = new RbacPermissionsGuard(reflector as unknown as Reflector, resolver as never);
  });

  it('allows routes without @RequirePermissions (no DB lookup)', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(guard.canActivate(ctx({ id: 'u1' }))).resolves.toBe(true);
    expect(resolver.checkUserHasPermissions).not.toHaveBeenCalled();
  });

  it('denies when the DB says the permission is absent — even if a stale token claim grants it', async () => {
    reflector.getAllAndOverride.mockReturnValue(['dashboard.view']);
    resolver.checkUserHasPermissions.mockResolvedValue(false);
    // The token still claims the permission; the DB revoked it → drift is fixed.
    await expect(
      guard.canActivate(ctx({ id: 'u1', permissions: ['dashboard.view'] })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows when the DB resolver grants the required permissions', async () => {
    reflector.getAllAndOverride.mockReturnValue(['dashboard.view']);
    resolver.checkUserHasPermissions.mockResolvedValue(true);
    await expect(guard.canActivate(ctx({ id: 'u1' }))).resolves.toBe(true);
    expect(resolver.checkUserHasPermissions).toHaveBeenCalledWith('u1', ['dashboard.view']);
  });

  it('rejects an unauthenticated request', async () => {
    reflector.getAllAndOverride.mockReturnValue(['dashboard.view']);
    await expect(guard.canActivate(ctx(undefined))).rejects.toThrow(ForbiddenException);
  });
});
