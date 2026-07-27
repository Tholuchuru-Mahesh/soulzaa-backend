import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user';
import { GameLobbyStatus } from '@prisma/client';
import { GamesRepository } from '../../modules/games/repositories/games.repository';
import { GamesService } from '../../modules/games/services/games.service';
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
  private readonly hostDisconnectTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    manager: SocketManager,
    private readonly gamesService: GamesService,
    private readonly gamesRepo: GamesRepository,
  ) {
    super(manager);
  }

  override async handleConnection(client: Socket): Promise<void> {
    await super.handleConnection(client);
    const user = client.data.user as AuthenticatedUser | undefined;
    if (user?.id) {
      for (const [key, timer] of this.hostDisconnectTimers.entries()) {
        if (key.endsWith(`:${user.id}`)) {
          clearTimeout(timer);
          this.hostDisconnectTimers.delete(key);
        }
      }
    }
  }

  override async handleDisconnect(client: Socket): Promise<void> {
    await super.handleDisconnect(client);
    const user = client.data.user as AuthenticatedUser | undefined;
    if (!user?.id) return;

    try {
      const code = await this.gamesRepo.findActiveLobbyForParticipant(user.id);
      if (!code) return;

      const lobby = await this.gamesRepo.getLobbyByCode(code);
      if (!lobby || lobby.status !== GameLobbyStatus.OPEN) return;

      if (lobby.hostId === user.id) {
        const timerKey = `${lobby.id}:${user.id}`;
        if (this.hostDisconnectTimers.has(timerKey)) {
          clearTimeout(this.hostDisconnectTimers.get(timerKey));
        }
        const timeout = setTimeout(() => {
          this.hostDisconnectTimers.delete(timerKey);
          void this.gamesService.transferLobbyHost(lobby.id, user.id);
        }, 60000);
        this.hostDisconnectTimers.set(timerKey, timeout);
      }
    } catch {
      // Ignore disconnect errors defensively
    }
  }

  /**
   * Ephemeral board-game "aim" preview relay (Carrom striker aim, etc.). Unlike
   * committed moves — which go through `POST /games/sessions/:id/moves` so they
   * are validated + logged for reconnect — an aim frame is high-frequency, not
   * stored, and carries no game authority, so it is a pure socket-to-socket
   * broadcast to the session room. Kept in the gateway (not the games module) so
   * the infra→module boundary holds: there is no domain logic here, only fan-out.
   * The sender must already be in the target room (it joined via `room:join`),
   * which bars cross-room spam. The frame echoes to everyone in the room EXCEPT
   * the sender (its own client already renders its aim).
   */
  @SubscribeMessage('game:aim')
  onGameAim(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { sessionId?: unknown } & Record<string, unknown>,
  ): void {
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : null;
    if (!sessionId || !client.rooms.has(sessionId)) return;
    const user = client.data.user as AuthenticatedUser | undefined;
    client.to(sessionId).emit('game.aim_received', { ...body, playerId: user?.id });
  }

  /**
   * In-match quick-chat emote relay. Like `game:aim`, an emote carries no game
   * authority and is not stored, so it is a pure room broadcast — kept in the
   * gateway so the boundary holds. Only allowlisted ids cross the wire (never
   * free text), matching the legacy anti-abuse rule; the id is resolved to text
   * client-side. Broadcast to the room EXCEPT the sender (its client echoes its
   * own emote optimistically).
   */
  @SubscribeMessage('game:emote')
  onGameEmote(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { sessionId?: unknown; emoteId?: unknown },
  ): void {
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : null;
    const emoteId = typeof body?.emoteId === 'string' ? body.emoteId : null;
    if (!sessionId || !emoteId || !client.rooms.has(sessionId) || !GAME_EMOTE_IDS.has(emoteId)) {
      return;
    }
    const user = client.data.user as AuthenticatedUser | undefined;
    client.to(sessionId).emit('game.emote_received', { sessionId, playerId: user?.id, emoteId });
  }
}

/** Allowlisted quick-chat emote ids (id-only wire; text resolved client-side). */
const GAME_EMOTE_IDS: ReadonlySet<string> = new Set<string>([
  'good_luck',
  'nice_move',
  'well_played',
  'oops',
  'good_game',
  'hurry_up',
  'thanks',
  'close_one',
  'e_smile',
  'e_thumbs',
  'e_clap',
  'e_party',
  'e_sweat',
  'e_cry',
  'e_heart',
  'e_fire',
]);

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
