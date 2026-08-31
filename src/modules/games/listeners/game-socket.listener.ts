import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { AUDIO_ROOM_NAMESPACE } from 'src/modules/audio-rooms/constants/audio-room.constants';
import { GAME_SOCKET_EVENTS, GAMES_NAMESPACE } from '../constants/games.constants';
import {
  GAME_EVENTS,
  GameCancelledEvent,
  GameLobbyCancelledEvent,
  GameLobbyCreatedEvent,
  GameLobbyJoinedEvent,
  GameLobbyLeftEvent,
  GameLobbyMemberKickedEvent,
  GameLobbyMemberReadyEvent,
  GameLobbySettingsUpdatedEvent,
  GameLobbyTeamChangedEvent,
  GameForfeitEvent,
  GameHostChangedEvent,
  GameMatchCancelledEvent,
  GameMatchFoundEvent,
  GameMatchReadyProgressEvent,
  GameMoveEvent,
  GameResultDisputedEvent,
  GameResultReportedEvent,
  GameSettledEvent,
  GameStartedEvent,
  GameTurnForceAdvancedEvent,
  GameTurnResyncRequestedEvent,
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
      // ...and tell the AUDIO ROOM, which is where the spectators are.
      //
      // None of the three fan-outs above can reach them: they are not in the
      // lobby, not participants, and cannot be in the session room because
      // they have no session id to join until they learn the match exists.
      // Their only source of that fact was the room's 10s status poll, so a
      // watcher saw the game appear up to ten seconds after it started.
      this.toRoom(e.payload.roomId, e.payload.sessionId);
    });
    this.bus.subscribe<GameSettledEvent>(GAME_EVENTS.SETTLED, (e) => {
      // The same room-channel nudge the start path uses — a watcher must learn
      // the match ENDED as promptly as they learned it began, or the window
      // lingers until the next poll tick.
      this.toRoom(e.payload.roomId, e.payload.sessionId);
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
      // Same room-channel nudge as SETTLED — a cancelled match must clear a
      // watcher's window immediately, not on the next poll tick.
      this.toRoom(e.payload.roomId, e.payload.sessionId);
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
    // Ready state toggle: fan out to the entire lobby room so all members see the update.
    this.bus.subscribe<GameLobbyMemberReadyEvent>(GAME_EVENTS.LOBBY_MEMBER_READY, (e) =>
      this.toLobby(e.payload.code, GAME_SOCKET_EVENTS.LOBBY_MEMBER_READY, e.payload),
    );
    // Host updated open-lobby settings: fan out to the entire lobby room.
    this.bus.subscribe<GameLobbySettingsUpdatedEvent>(GAME_EVENTS.LOBBY_SETTINGS_UPDATED, (e) =>
      this.toLobby(e.payload.code, GAME_SOCKET_EVENTS.LOBBY_SETTINGS_UPDATED, e.payload),
    );
    // Turn watchdog: give the room a last chance to resync before a force-advance.
    this.bus.subscribe<GameTurnResyncRequestedEvent>(GAME_EVENTS.TURN_RESYNC_REQUESTED, (e) => {
      this.sockets.emitToNamespaceRoom(
        GAMES_NAMESPACE,
        e.payload.sessionId,
        GAME_SOCKET_EVENTS.TURN_RESYNC_REQUESTED,
        e.payload,
      );
    });
    // Turn watchdog: a stalled turn was force-advanced past an unresponsive seat.
    this.bus.subscribe<GameTurnForceAdvancedEvent>(GAME_EVENTS.TURN_FORCE_ADVANCED, (e) => {
      this.sockets.emitToNamespaceRoom(
        GAMES_NAMESPACE,
        e.payload.sessionId,
        GAME_SOCKET_EVENTS.TURN_FORCE_ADVANCED,
        e.payload,
      );
    });
    // The host reported a result — tell the room so another client can confirm
    // (or dispute) it before the platform settles.
    this.bus.subscribe<GameResultReportedEvent>(GAME_EVENTS.RESULT_REPORTED, (e) => {
      this.sockets.emitToNamespaceRoom(
        GAMES_NAMESPACE,
        e.payload.sessionId,
        GAME_SOCKET_EVENTS.RESULT_REPORTED,
        e.payload,
      );
    });
    // The host role moved. Every socket in the session room needs this — the
    // new host has to start driving the bot seats, and the old one has to stop
    // — so it goes to the room, not just to the two users involved.
    this.bus.subscribe<GameHostChangedEvent>(GAME_EVENTS.HOST_CHANGED, (e) => {
      this.sockets.emitToNamespaceRoom(
        GAMES_NAMESPACE,
        e.payload.sessionId,
        GAME_SOCKET_EVENTS.HOST_CHANGED,
        e.payload,
      );
      this.sockets.emitToUserEverywhere(
        e.payload.hostId,
        GAME_SOCKET_EVENTS.HOST_CHANGED,
        e.payload,
      );
    });
    // A reported result was disputed — settlement withheld pending admin review.
    this.bus.subscribe<GameResultDisputedEvent>(GAME_EVENTS.RESULT_DISPUTED, (e) => {
      this.sockets.emitToNamespaceRoom(
        GAMES_NAMESPACE,
        e.payload.sessionId,
        GAME_SOCKET_EVENTS.RESULT_DISPUTED,
        e.payload,
      );
    });
  }

  private toLobby(code: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(GAMES_NAMESPACE, code, event, payload);
  }

  /**
   * Nudges an audio room that its game situation changed, on the room's OWN
   * channel (`/audio-room`, keyed by room id) — the one channel every member
   * of the room is already subscribed to, spectators included.
   *
   * Deliberately a bare signal rather than the game payload. Who may see what
   * in a room-bound match is decided by the membership-gated status endpoint,
   * and duplicating any of that here would be a second, weaker copy of those
   * rules on a channel with a much wider audience. Clients treat this purely
   * as "ask again now", so the authoritative answer still comes from the same
   * gated read as before — just immediately instead of on the next poll tick.
   *
   * A no-op for a match with no room: those have no spectators to inform.
   */
  private toRoom(roomId: string | null, sessionId: string | null): void {
    if (!roomId) return;
    this.sockets.emitToNamespaceRoom(
      AUDIO_ROOM_NAMESPACE,
      roomId,
      GAME_SOCKET_EVENTS.ROOM_GAME_CHANGED,
      { roomId, sessionId },
    );
  }
}
