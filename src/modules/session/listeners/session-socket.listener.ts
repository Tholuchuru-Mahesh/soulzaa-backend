import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { SESSION_EVENTS, type SessionLoggedOutEvent } from '../events/session.events';

/**
 * Ties session revocation to realtime teardown: when a user is logged out of all
 * devices (self or admin-forced), disconnect their live sockets so presence goes
 * offline (PRD "Mark User Offline"). Access-token revocation is already immediate
 * via the token epoch; this closes the WebSocket side, which the WS handshake
 * guard does not re-check per message.
 */
@Injectable()
export class SessionSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<SessionLoggedOutEvent>(SESSION_EVENTS.LOGGED_OUT, (event) => {
      if (event.payload.allDevices) {
        this.sockets.disconnectUserEverywhere(event.payload.userId);
      }
    });
  }
}
