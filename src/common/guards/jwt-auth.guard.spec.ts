import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IRoleSource } from '../interfaces/role-source.interface';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * The access token carries a `roles` claim, but it is a projection minted at
 * login — it goes stale the moment a role is granted or revoked. Guards already
 * resolve roles from the RBAC store per request; downstream code reading
 * `request.user.roles` (audio/video room staff bypasses) was still trusting the
 * claim. Overwriting it here makes one authority for the whole request.
 */
describe('JwtAuthGuard — request roles come from the RBAC store', () => {
  const parentProto = Object.getPrototypeOf(JwtAuthGuard.prototype);

  let reflector: { getAllAndOverride: jest.Mock };
  let roleSource: { getRoleNames: jest.Mock };
  let guard: JwtAuthGuard;
  let parentCanActivate: jest.SpyInstance;

  const contextFor = (user: unknown) => {
    const request = { user };
    return {
      ctx: {
        getType: () => 'http',
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext,
      request,
    };
  };

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    roleSource = { getRoleNames: jest.fn().mockResolvedValue([]) };
    guard = new JwtAuthGuard(
      reflector as unknown as Reflector,
      roleSource as unknown as IRoleSource,
    );
    parentCanActivate = jest.spyOn(parentProto, 'canActivate').mockResolvedValue(true);
  });

  afterEach(() => jest.restoreAllMocks());

  it('replaces a stale role claim with the roles the RBAC store reports', async () => {
    roleSource.getRoleNames.mockResolvedValue(['MODERATOR']);
    const { ctx, request } = contextFor({ id: 'u-1', roles: ['ADMIN'] });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(request.user).toMatchObject({ roles: ['MODERATOR'] });
    expect(roleSource.getRoleNames).toHaveBeenCalledWith('u-1');
  });

  it('grants roles the claim never had', async () => {
    roleSource.getRoleNames.mockResolvedValue(['ADMIN']);
    const { ctx, request } = contextFor({ id: 'u-1', roles: [] });

    await guard.canActivate(ctx);

    expect(request.user).toMatchObject({ roles: ['ADMIN'] });
  });

  it('drops custom role names that are not platform roles', async () => {
    roleSource.getRoleNames.mockResolvedValue(['ADMIN', 'REGIONAL_AUDITOR']);
    const { ctx, request } = contextFor({ id: 'u-1', roles: [] });

    await guard.canActivate(ctx);

    expect(request.user).toMatchObject({ roles: ['ADMIN'] });
  });

  it('does not resolve roles for @Public routes', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const { ctx } = contextFor(undefined);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(roleSource.getRoleNames).not.toHaveBeenCalled();
    expect(parentCanActivate).not.toHaveBeenCalled();
  });

  it('does not resolve roles when authentication fails', async () => {
    parentCanActivate.mockResolvedValue(false);
    const { ctx } = contextFor({ id: 'u-1', roles: ['ADMIN'] });

    await expect(guard.canActivate(ctx)).resolves.toBe(false);
    expect(roleSource.getRoleNames).not.toHaveBeenCalled();
  });

  it('leaves the request untouched for non-http contexts', async () => {
    const { ctx } = contextFor({ id: 'u-1', roles: ['ADMIN'] });
    (ctx as unknown as { getType: () => string }).getType = () => 'ws';

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(roleSource.getRoleNames).not.toHaveBeenCalled();
  });
});
