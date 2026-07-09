import { GameCode, GameCurrency, GameSessionStatus } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

export const GAME_EVENTS = {
  LOBBY_CREATED: 'game.lobby_created',
  LOBBY_JOINED: 'game.lobby_joined',
  LOBBY_LEFT: 'game.lobby_left',
  LOBBY_CANCELLED: 'game.lobby_cancelled',
  STARTED: 'game.started',
  SETTLED: 'game.settled',
  CANCELLED: 'game.cancelled',
} as const;

export interface GameLobbyView {
  lobbyId: string;
  code: string;
  gameCode: GameCode;
  hostId: string;
  roomId: string | null;
  currency: GameCurrency;
  stake: number;
  maxPlayers: number;
  members: string[];
}

export class GameLobbyCreatedEvent extends DomainEvent<GameLobbyView> {
  readonly name = GAME_EVENTS.LOBBY_CREATED;
}

export class GameLobbyJoinedEvent extends DomainEvent<GameLobbyView & { userId: string }> {
  readonly name = GAME_EVENTS.LOBBY_JOINED;
}

export class GameLobbyLeftEvent extends DomainEvent<{
  lobbyId: string;
  code: string;
  userId: string;
  members: string[];
}> {
  readonly name = GAME_EVENTS.LOBBY_LEFT;
}

export class GameLobbyCancelledEvent extends DomainEvent<{
  lobbyId: string;
  code: string;
  reason: string;
}> {
  readonly name = GAME_EVENTS.LOBBY_CANCELLED;
}

export class GameStartedEvent extends DomainEvent<{
  sessionId: string;
  lobbyId: string | null;
  joinCode: string;
  gameCode: GameCode;
  roomId: string | null;
  currency: GameCurrency;
  stake: number;
  potAmount: number;
  participants: string[];
}> {
  readonly name = GAME_EVENTS.STARTED;
}

export class GameSettledEvent extends DomainEvent<{
  sessionId: string;
  gameCode: GameCode;
  roomId: string | null;
  currency: GameCurrency;
  potAmount: number;
  payoutTotal: number;
  rakeAmount: number;
  winners: string[];
  payouts: { userId: string; amount: number }[];
}> {
  readonly name = GAME_EVENTS.SETTLED;
}

export class GameCancelledEvent extends DomainEvent<{
  sessionId: string;
  gameCode: GameCode;
  roomId: string | null;
  status: GameSessionStatus;
  refundedUserIds: string[];
}> {
  readonly name = GAME_EVENTS.CANCELLED;
}
