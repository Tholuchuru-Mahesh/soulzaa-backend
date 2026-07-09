import { Global, Module } from '@nestjs/common';
import { WsJwtGuard } from '../../common/guards/ws-jwt.guard';
import { SOCKET_GATEWAYS } from './socket.gateway';
import { SocketManager } from './socket.manager';

/**
 * Realtime transport module. Registers the namespace gateways (/notifications,
 * /chat, /audio-room, /video-room, /live, /gifts), the shared SocketManager
 * (auth + presence + rooms), and the WS auth guard. The Redis adapter itself is
 * installed in main.ts (it needs the app instance) for horizontal scaling.
 */
@Global()
@Module({
  providers: [SocketManager, WsJwtGuard, ...SOCKET_GATEWAYS],
  exports: [SocketManager, WsJwtGuard],
})
export class SocketModule {}
