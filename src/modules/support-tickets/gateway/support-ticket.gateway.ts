import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { BaseGateway } from 'src/infra/socket/base.gateway';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { SUPPORT_NAMESPACE } from '../constants/support-tickets.constants';

/**
 * `/support` namespace: live ticket conversations.
 *
 * Declares no message handlers of its own. Clients join a ticket with the
 * inherited `room:join` (`{ roomId: 'ticket_<id>' }`, gated by
 * SupportTicketRoomJoinPolicy) and then only listen — messages are posted over
 * REST so they are persisted, authorised and audited exactly once, and the
 * server fans the saved row out from `SupportTicketService`. Accepting a
 * message over the socket instead would create a second, unaudited write path.
 */
@WebSocketGateway({ namespace: SUPPORT_NAMESPACE })
export class SupportTicketGateway extends BaseGateway {
  @WebSocketServer() protected readonly server!: Server;

  constructor(manager: SocketManager) {
    super(manager);
  }
}
