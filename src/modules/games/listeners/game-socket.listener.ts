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
  GameLobbyMemberKickedEvent,
  GameLobbyTeamChangedEvent,
  GameForfeitEvent,
  GameMatchCancelledEvent,
  GameMatchFoundEvent,
  GameMatchReadyProgressEvent,
  GameMoveEvent,
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
    // In-session move relay: fan out to every socket in the session room. The
    // sender is included (its client rejects its own echo), matching the legacy
    // `io.to(room)` broadcast.
    this.bus.subscribe<GameMoveEvent>(GAME_EVENTS.MOVE, (e) => {
      this.sockets.emitToNamespaceRoom(
        GAMES_NAMESPACE,
        e.payload.sessionId,
        GAME_SOCKET_EVENTS.MOVE_RECEIVED,
        e.payload,
      );
    });
    // A player forfeited: tell the session room (clients withdraw the seat) and
    // the forfeiter's own sockets. A sole-survivor auto-settle emits SETTLED next.
    this.bus.subscribe<GameForfeitEvent>(GAME_EVENTS.FORFEITED, (e) => {
      this.sockets.emitToNamespaceRoom(
        GAMES_NAMESPACE,
        e.payload.sessionId,
        GAME_SOCKET_EVENTS.PLAYER_FORFEITED,
        e.payload,
      );
      this.sockets.emitToUserEverywhere(
        e.payload.userId,
        GAME_SOCKET_EVENTS.PLAYER_FORFEITED,
        e.payload,
      );
    });
    // Matchmaking: the matched players aren't in any room yet, so match_found /
    // ready_progress / cancelled fan out per-user across all their sockets.
    this.bus.subscribe<GameMatchFoundEvent>(GAME_EVENTS.MATCH_FOUND, (e) => {
      for (const userId of e.payload.players) {
        this.sockets.emitToUserEverywhere(userId, GAME_SOCKET_EVENTS.MATCH_FOUND, e.payload);
      }
    });
    this.bus.subscribe<GameMatchReadyProgressEvent>(GAME_EVENTS.MATCH_READY_PROGRESS, (e) => {
      for (const userId of e.payload.players) {
        this.sockets.emitToUserEverywhere(
          userId,
          GAME_SOCKET_EVENTS.MATCH_READY_PROGRESS,
          e.payload,
        );
      }
    });
    this.bus.subscribe<GameMatchCancelledEvent>(GAME_EVENTS.MATCH_CANCELLED, (e) => {
      for (const userId of e.payload.players) {
        this.sockets.emitToUserEverywhere(userId, GAME_SOCKET_EVENTS.MATCH_CANCELLED, e.payload);
      }
    });
    // Team change happens inside a lobby → fan out to the lobby code room.
    this.bus.subscribe<GameLobbyTeamChangedEvent>(GAME_EVENTS.LOBBY_TEAM_CHANGED, (e) => {
      this.sockets.emitToNamespaceRoom(
        GAMES_NAMESPACE,
        e.payload.code,
        GAME_SOCKET_EVENTS.LOBBY_TEAM_CHANGED,
        e.payload,
      );
    });
    // Kick: tell the lobby room (so it updates the roster) and the kicked user.
    this.bus.subscribe<GameLobbyMemberKickedEvent>(GAME_EVENTS.LOBBY_MEMBER_KICKED, (e) => {
      this.sockets.emitToNamespaceRoom(
        GAMES_NAMESPACE,
        e.payload.code,
        GAME_SOCKET_EVENTS.LOBBY_MEMBER_KICKED,
        e.payload,
      );
      this.sockets.emitToUserEverywhere(
        e.payload.userId,
        GAME_SOCKET_EVENTS.LOBBY_MEMBER_KICKED,
        e.payload,
      );
    });
  }

  private toLobby(code: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(GAMES_NAMESPACE, code, event, payload);
  }
}
