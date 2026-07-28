import { ExecutionContext } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { TokenService } from '../../infra/auth/token.service';
import type { IRoleSource } from '../interfaces/role-source.interface';
import { WsJwtGuard } from './ws-jwt.guard';

/**
 * Socket connections are long-lived, so a role claim minted at connect time can
 * outlive a revocation by hours. Gateways read `socket.data.user.roles` for the
 * platform-staff bypass in room chat policy, so it must come from the RBAC store
 * for the same reason the HTTP path does.
 */
describe('WsJwtGuard — socket roles come from the RBAC store', () => {
  let tokenService: { verifyAccessToken: jest.Mock };
  let roleSource: { getRoleNames: jest.Mock };
  let guard: WsJwtGuard;

  const contextFor = (client: Partial<Socket>) =>
    ({
      switchToWs: () => ({ getClient: () => client }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    tokenService = { verifyAccessToken: jest.fn() };
    roleSource = { getRoleNames: jest.fn().mockResolvedValue([]) };
    guard = new WsJwtGuard(
      tokenService as unknown as TokenService,
      roleSource as unknown as IRoleSource,
    );
  });

  it('replaces the stale claim with roles the RBAC store reports', async () => {
    tokenService.verifyAccessToken.mockResolvedValue({ sub: 'u-1', roles: ['ADMIN'] });
    roleSource.getRoleNames.mockResolvedValue(['MODERATOR']);
    const client = { handshake: { auth: { token: 't' } }, data: {} } as unknown as Socket;

    await expect(guard.canActivate(contextFor(client))).resolves.toBe(true);

    expect((client.data as { user: { roles: string[] } }).user.roles).toEqual(['MODERATOR']);
  });

  it('drops role names outside the platform enum', async () => {
    tokenService.verifyAccessToken.mockResolvedValue({ sub: 'u-1', roles: [] });
    roleSource.getRoleNames.mockResolvedValue(['ADMIN', 'REGIONAL_AUDITOR']);
    const client = { handshake: { auth: { token: 't' } }, data: {} } as unknown as Socket;

    await guard.canActivate(contextFor(client));

    expect((client.data as { user: { roles: string[] } }).user.roles).toEqual(['ADMIN']);
  });

  it('rejects an invalid token without resolving roles', async () => {
    tokenService.verifyAccessToken.mockRejectedValue(new Error('bad token'));
    const client = { handshake: { auth: { token: 't' } }, data: {} } as unknown as Socket;

    await expect(guard.canActivate(contextFor(client))).rejects.toThrow(WsException);
    expect(roleSource.getRoleNames).not.toHaveBeenCalled();
  });
});
