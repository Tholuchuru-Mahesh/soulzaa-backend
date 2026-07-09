import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { GAME_SOCKET_EVENTS, GAMES_NAMESPACE } from '../constants/games.constants';
import {
  GAME_EVENTS,
  GameCancelledEvent,
  GameLobbyCancelledEvent,
  GameLobbyCreatedEvent,
  GameLobbyJoinedEvent,
  GameLobbyLeftEvent,
  GameSettledEvent,
  GameStartedEvent,
} from '../events/game.events';

/**
 * Bridges game DomainEvents to the /games socket namespace. Lobby traffic is
 * keyed by the join code (the socket room clients join); once a match starts,
 * traffic is also keyed by the session id, and terminal events additionally
 * reach each participant across all their sockets.
 */
@Injectable()
export class GameSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<GameLobbyCreatedEvent>(GAME_EVENTS.LOBBY_CREATED, (e) =>
      this.toLobby(e.payload.code, GAME_SOCKET_EVENTS.LOBBY_CREATED, e.payload),
    );
    this.bus.subscribe<GameLobbyJoinedEvent>(GAME_EVENTS.LOBBY_JOINED, (e) =>
      this.toLobby(e.payload.code, GAME_SOCKET_EVENTS.LOBBY_JOINED, e.payload),
    );
    this.bus.subscribe<GameLobbyLeftEvent>(GAME_EVENTS.LOBBY_LEFT, (e) =>
      this.toLobby(e.payload.code, GAME_SOCKET_EVENTS.LOBBY_LEFT, e.payload),
    );
    this.bus.subscribe<GameLobbyCancelledEvent>(GAME_EVENTS.LOBBY_CANCELLED, (e) =>
      this.toLobby(e.payload.code, GAME_SOCKET_EVENTS.LOBBY_CANCELLED, e.payload),
    );
    this.bus.subscribe<GameStartedEvent>(GAME_EVENTS.STARTED, (e) => {
      this.toLobby(e.payload.joinCode, GAME_SOCKET_EVENTS.STARTED, e.payload);
      this.sockets.emitToNamespaceRoom(
        GAMES_NAMESPACE,
        e.payload.sessionId,
        GAME_SOCKET_EVENTS.STARTED,
        e.payload,
      );
      for (const userId of e.payload.participants) {
        this.sockets.emitToUserEverywhere(userId, GAME_SOCKET_EVENTS.STARTED, e.payload);
      }
    });
    this.bus.subscribe<GameSettledEvent>(GAME_EVENTS.SETTLED, (e) => {
      this.sockets.emitToNamespaceRoom(
        GAMES_NAMESPACE,
        e.payload.sessionId,
        GAME_SOCKET_EVENTS.SETTLED,
        e.payload,
      );
      for (const p of e.payload.payouts) {
        this.sockets.emitToUserEverywhere(p.userId, GAME_SOCKET_EVENTS.SETTLED, e.payload);
      }
    });
    this.bus.subscribe<GameCancelledEvent>(GAME_EVENTS.CANCELLED, (e) => {
      this.sockets.emitToNamespaceRoom(
        GAMES_NAMESPACE,
        e.payload.sessionId,
        GAME_SOCKET_EVENTS.CANCELLED,
        e.payload,
      );
      for (const userId of e.payload.refundedUserIds) {
        this.sockets.emitToUserEverywhere(userId, GAME_SOCKET_EVENTS.CANCELLED, e.payload);
      }
    });
  }

  private toLobby(code: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(GAMES_NAMESPACE, code, event, payload);
  }
}
