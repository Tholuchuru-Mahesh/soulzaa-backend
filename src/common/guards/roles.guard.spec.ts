import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

const ctx = (user: unknown) =>
  ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as never;

describe('RolesGuard (RBAC-backed — one source of truth)', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let roleSource: { getRoleNames: jest.Mock };
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    roleSource = { getRoleNames: jest.fn() };
    guard = new RolesGuard(reflector as unknown as Reflector, roleSource as never);
  });

  it('allows routes without @Roles (no role lookup)', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(guard.canActivate(ctx({ id: 'u1' }))).resolves.toBe(true);
    expect(roleSource.getRoleNames).not.toHaveBeenCalled();
  });

  it('allows a role assigned in the RBAC store even when the token claim omits it', async () => {
    reflector.getAllAndOverride.mockReturnValue(['ADMIN']);
    roleSource.getRoleNames.mockResolvedValue(['ADMIN']);
    // The token was minted before the promotion — RBAC is authoritative.
    await expect(guard.canActivate(ctx({ id: 'u1', roles: [] }))).resolves.toBe(true);
    expect(roleSource.getRoleNames).toHaveBeenCalledWith('u1');
  });

  it('denies when the RBAC store revoked the role, even though a stale token claims it', async () => {
    reflector.getAllAndOverride.mockReturnValue(['ADMIN']);
    roleSource.getRoleNames.mockResolvedValue(['USER']);
    await expect(guard.canActivate(ctx({ id: 'u1', roles: ['ADMIN'] }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('lets SUPER_ADMIN through any @Roles route', async () => {
    reflector.getAllAndOverride.mockReturnValue(['MODERATOR']);
    roleSource.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);
    await expect(guard.canActivate(ctx({ id: 'u1' }))).resolves.toBe(true);
  });

  it('rejects an unauthenticated request without consulting the store', async () => {
    reflector.getAllAndOverride.mockReturnValue(['ADMIN']);
    await expect(guard.canActivate(ctx(undefined))).rejects.toThrow(ForbiddenException);
    expect(roleSource.getRoleNames).not.toHaveBeenCalled();
  });
});
