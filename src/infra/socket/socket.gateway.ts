import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server } from 'socket.io';
import { BaseGateway } from './base.gateway';
import { SocketManager } from './socket.manager';

/**
 * The platform's realtime namespaces. Each is a thin transport shell over
 * BaseGateway — it inherits handshake auth, presence, room join/leave and the
 * broadcast helpers, and only declares its namespace. Domain-specific message
 * handlers are added per module in later steps. CORS, heartbeat and connection
 * recovery are configured once at the server level in SocketAdapter, so they
 * apply to every namespace here automatically.
 */

@WebSocketGateway({ namespace: '/notifications' })
export class NotificationsGateway extends BaseGateway {
  @WebSocketServer() protected readonly server!: Server;
  constructor(manager: SocketManager) {
    super(manager);
  }
}

@WebSocketGateway({ namespace: '/chat' })
export class ChatGateway extends BaseGateway {
  @WebSocketServer() protected readonly server!: Server;
  constructor(manager: SocketManager) {
    super(manager);
  }
}

@WebSocketGateway({ namespace: '/call' })
export class CallGateway extends BaseGateway {
  @WebSocketServer() protected readonly server!: Server;
  constructor(manager: SocketManager) {
    super(manager);
  }
}

@WebSocketGateway({ namespace: '/audio-room' })
export class AudioRoomGateway extends BaseGateway {
  @WebSocketServer() protected readonly server!: Server;
  constructor(manager: SocketManager) {
    super(manager);
  }
}

@WebSocketGateway({ namespace: '/video-room' })
export class VideoRoomGateway extends BaseGateway {
  @WebSocketServer() protected readonly server!: Server;
  constructor(manager: SocketManager) {
    super(manager);
  }
}

@WebSocketGateway({ namespace: '/live' })
export class LiveGateway extends BaseGateway {
  @WebSocketServer() protected readonly server!: Server;
  constructor(manager: SocketManager) {
    super(manager);
  }
}

@WebSocketGateway({ namespace: '/gifts' })
export class GiftsGateway extends BaseGateway {
  @WebSocketServer() protected readonly server!: Server;
  constructor(manager: SocketManager) {
    super(manager);
  }
}

@WebSocketGateway({ namespace: '/games' })
export class GamesGateway extends BaseGateway {
  @WebSocketServer() protected readonly server!: Server;
  constructor(manager: SocketManager) {
    super(manager);
  }
}

/** All namespace gateways — registered as providers in SocketModule. */
export const SOCKET_GATEWAYS = [
  NotificationsGateway,
  ChatGateway,
  CallGateway,
  AudioRoomGateway,
  VideoRoomGateway,
  LiveGateway,
  GiftsGateway,
  GamesGateway,
];
