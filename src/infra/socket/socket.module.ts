import { Global, Module } from '@nestjs/common';
import { WsJwtGuard } from '../../common/guards/ws-jwt.guard';
import {
  ROOM_JOIN_POLICY_REGISTRY,
  type RoomJoinPolicyRegistry,
} from './room-join-policy.interface';
import { SOCKET_GATEWAYS } from './socket.gateway';
import { SocketManager } from './socket.manager';

/**
 * Realtime transport module. Registers the namespace gateways (/notifications,
 * /chat, /audio-room, /video-room, /live, /gifts), the shared SocketManager
 * (auth + presence + rooms), and the WS auth guard. The Redis adapter itself is
 * installed in main.ts (it needs the app instance) for horizontal scaling.
 *
 * Also provides the empty `ROOM_JOIN_POLICY_REGISTRY` map — namespaces that
 * need `room:join` gated (games, casino) populate it via their own
 * self-registering `OnModuleInit` listeners; every other namespace leaves it
 * untouched and keeps `SocketManager.joinRoom`'s unrestricted default.
 */
@Global()
@Module({
  providers: [
    SocketManager,
    WsJwtGuard,
    { provide: ROOM_JOIN_POLICY_REGISTRY, useValue: new Map() as RoomJoinPolicyRegistry },
    ...SOCKET_GATEWAYS,
  ],
  exports: [SocketManager, WsJwtGuard, ROOM_JOIN_POLICY_REGISTRY],
})
export class SocketModule {}
