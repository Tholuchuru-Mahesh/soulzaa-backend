import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { TokenService } from '../../infra/auth/token.service';

/**
 * Authenticates Socket.IO connections/messages from the handshake auth token
 * (`socket.handshake.auth.token` or the Authorization header). On success it
 * stashes the user on `socket.data.user` for gateways to read.
 */
@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(private readonly tokenService: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<Socket>();
    const token = this.extractToken(client);
    if (!token) throw new WsException('Unauthorized: missing token');

    try {
      const claims = await this.tokenService.verifyAccessToken(token);
      client.data.user = { ...claims, id: claims.sub, roles: claims.roles ?? [] };
      return true;
    } catch {
      throw new WsException('Unauthorized: invalid token');
    }
  }

  private extractToken(client: Socket): string | undefined {
    const authToken = client.handshake?.auth?.token as string | undefined;
    if (authToken) return authToken.replace(/^Bearer\s+/i, '');
    const header = client.handshake?.headers?.authorization;
    return header?.replace(/^Bearer\s+/i, '');
  }
}
