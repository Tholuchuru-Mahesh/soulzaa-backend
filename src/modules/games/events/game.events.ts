import { GameCode, GameCurrency, GameMode, GameSessionStatus, GameTeam } from '@prisma/client';
import { DomainEvent } from 'src/common/events';
import type { MatchCancelReason, MatchType } from '../services/matchmaking-core';

/** One lobby member's team + bot info, surfaced to the waiting-room UI. */
export interface LobbyMemberView {
  userId: string;
  team: GameTeam | null;
  isBot: boolean;
  botName: string | null;
  /** Real player identity (fullName ?? username) — botName for a bot seat. */
  displayName: string | null;
  /** Resolved avatar URL — always null for a bot seat. */
  avatar: string | null;
  /** Whether this member has toggled ready. Bots are always ready. */
  isReady: boolean;
}

export const GAME_EVENTS = {
  LOBBY_CREATED: 'game.lobby_created',
  LOBBY_JOINED: 'game.lobby_joined',
  LOBBY_LEFT: 'game.lobby_left',
  LOBBY_CANCELLED: 'game.lobby_cancelled',
  STARTED: 'game.started',
  SETTLED: 'game.settled',
  CANCELLED: 'game.cancelled',
  MOVE: 'game.move',
  FORFEITED: 'game.forfeited',
  MATCH_FOUND: 'game.match_found',
  MATCH_READY_PROGRESS: 'game.match_ready_progress',
  MATCH_CANCELLED: 'game.match_cancelled',
  LOBBY_TEAM_CHANGED: 'game.lobby_team_changed',
  LOBBY_MEMBER_KICKED: 'game.lobby_member_kicked',
  LOBBY_MEMBER_READY: 'game.lobby_member_ready',
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
  mode: GameMode;
  isPrivate: boolean;
  hasPassword: boolean;
  members: string[];
  memberDetails: LobbyMemberView[];
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

/** A board-game move relayed in-session (peer-relay; the server never validates rules). */
export class GameMoveEvent extends DomainEvent<{
  sessionId: string;
  roomId: string | null;
  playerId: string;
  moveData: Record<string, unknown>;
  timestamp: number;
  currentTurnUserId: string | null;
}> {
  readonly name = GAME_EVENTS.MOVE;
}

/** A participant forfeited/left an active match. Clients withdraw the seat; if
 * the match auto-settles (sole survivor), a GameSettledEvent follows. */
export class GameForfeitEvent extends DomainEvent<{
  sessionId: string;
  gameCode: GameCode;
  roomId: string | null;
  userId: string;
  seat: number;
}> {
  readonly name = GAME_EVENTS.FORFEITED;
}

/** Matchmaking paired players — a ready-check opened. Fanned out per-user (no room yet). */
export class GameMatchFoundEvent extends DomainEvent<{
  v: number;
  matchId: string;
  gameCode: GameCode;
  stake: number;
  matchType: MatchType;
  players: string[];
  readySeconds: number;
  expiresAt: number;
}> {
  readonly name = GAME_EVENTS.MATCH_FOUND;
}

/** A matched player readied up — carries who is still pending. Per-user fan-out. */
export class GameMatchReadyProgressEvent extends DomainEvent<{
  v: number;
  matchId: string;
  players: string[];
  ready: string[];
  remaining: string[];
}> {
  readonly name = GAME_EVENTS.MATCH_READY_PROGRESS;
}

/** A ready-check dissolved (timeout/decline/operational). `requeued` re-enter the queue. */
export class GameMatchCancelledEvent extends DomainEvent<{
  v: number;
  matchId: string;
  reason: MatchCancelReason;
  players: string[];
  requeued: string[];
}> {
  readonly name = GAME_EVENTS.MATCH_CANCELLED;
}

/** A player's team changed in a TEAM_2V2 lobby. Fanned out to the lobby `code` room. */
export class GameLobbyTeamChangedEvent extends DomainEvent<{
  v: number;
  code: string;
  userId: string;
  team: GameTeam;
  teams: { A: string[]; B: string[] };
}> {
  readonly name = GAME_EVENTS.LOBBY_TEAM_CHANGED;
}

/** The host removed a member from the lobby. Notifies the room + the kicked user. */
export class GameLobbyMemberKickedEvent extends DomainEvent<{
  lobbyId: string;
  code: string;
  userId: string;
  members: string[];
}> {
  readonly name = GAME_EVENTS.LOBBY_MEMBER_KICKED;
}

export class GameLobbyMemberReadyEvent extends DomainEvent<{
  lobbyId: string;
  code: string;
  userId: string;
  isReady: boolean;
  memberDetails: LobbyMemberView[];
}> {
  readonly name = GAME_EVENTS.LOBBY_MEMBER_READY;
}
