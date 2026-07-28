import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { TokenService } from '../../infra/auth/token.service';
import { PLATFORM_ROLES, type PlatformRole } from '../constants';
import { ROLE_SOURCE, type IRoleSource } from '../interfaces/role-source.interface';

/**
 * Authenticates Socket.IO connections/messages from the handshake auth token
 * (`socket.handshake.auth.token` or the Authorization header). On success it
 * stashes the user on `socket.data.user` for gateways to read.
 *
 * Roles are taken from the RBAC store rather than the token claim: sockets are
 * long-lived, so a claim minted at connect time can outlive a revocation by
 * hours, and gateways read these roles for platform-staff bypasses.
 */
@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(
    private readonly tokenService: TokenService,
    @Inject(ROLE_SOURCE) private readonly roleSource: IRoleSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<Socket>();
    const token = this.extractToken(client);
    if (!token) throw new WsException('Unauthorized: missing token');

    let claims: Awaited<ReturnType<TokenService['verifyAccessToken']>>;
    try {
      claims = await this.tokenService.verifyAccessToken(token);
    } catch {
      throw new WsException('Unauthorized: invalid token');
    }

    const names = await this.roleSource.getRoleNames(claims.sub);
    const roles = names.filter((name): name is PlatformRole =>
      (PLATFORM_ROLES as readonly string[]).includes(name),
    );
    client.data.user = { ...claims, id: claims.sub, roles };
    return true;
  }

  private extractToken(client: Socket): string | undefined {
    const authToken = client.handshake?.auth?.token as string | undefined;
    if (authToken) return authToken.replace(/^Bearer\s+/i, '');
    const header = client.handshake?.headers?.authorization;
    return header?.replace(/^Bearer\s+/i, '');
  }
}
