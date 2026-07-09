import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Socket } from 'socket.io';
import type { AuthenticatedUser } from '../interfaces/authenticated-user';

/**
 * Injects the authenticated user (or one of its fields) into a WebSocket
 * message handler param. The WS counterpart of `@CurrentUser` (which is
 * HTTP-only); reads `socket.data.user` set by the socket auth middleware.
 */
export const WsUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const client = ctx.switchToWs().getClient<Socket>();
    const user: AuthenticatedUser | undefined = client.data?.user;
    return data ? user?.[data] : user;
  },
);
