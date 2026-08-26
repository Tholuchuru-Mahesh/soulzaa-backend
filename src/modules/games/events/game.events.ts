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
  LOBBY_SETTINGS_UPDATED: 'game.lobby_settings_updated',
  TURN_RESYNC_REQUESTED: 'game.turn_resync_requested',
  TURN_FORCE_ADVANCED: 'game.turn_force_advanced',
  RESULT_REPORTED: 'game.result_reported',
  RESULT_DISPUTED: 'game.result_disputed',
  HOST_CHANGED: 'game.host_changed',
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
  carromMode?: string | null;
  teamCoinAssignment?: string | null;
  isPrivate: boolean;
  hasPassword: boolean;
  members: string[];
  memberDetails: LobbyMemberView[];
}

export class GameLobbyCreatedEvent extends DomainEvent<GameLobbyView> {
  readonly name = GAME_EVENTS.LOBBY_CREATED;
}

export class GameLobbySettingsUpdatedEvent extends DomainEvent<GameLobbyView> {
  readonly name = GAME_EVENTS.LOBBY_SETTINGS_UPDATED;
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
  carromMode?: string | null;
  teamCoinAssignment?: string | null;
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
  /**
   * Everyone who played, winners included. `winners` and `payouts` alone cannot
   * identify the losers, so a consumer that needs to reach every player — the
   * notification bridge telling someone they lost — has no other source.
   */
  participants: string[];
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
  /**
   * The session revision this move produced (see `GameLiveState.rev`). A
   * client compares it against the revision of the snapshot it restored from,
   * so a spectator that joins mid-match can order this live event against an
   * in-flight `GET /sessions/:id/live` instead of guessing from wall clock.
   */
  rev: number;
}> {
  readonly name = GAME_EVENTS.MOVE;
}

/**
 * The session's host role moved to a different player.
 *
 * The host is not a cosmetic title in a peer-relay match: it is the client
 * that drives every BOT seat (only the host schedules a bot's move, and
 * `relayMove(onBehalfOf)` rejects anyone else), and it is the client that
 * reports the winner. So when the host stops being an active player — they
 * forfeited, or room ownership moved to someone not in the match — the role
 * has to follow the match or the bots simply stop and the board looks frozen.
 *
 * Clients must adopt `hostId` live: they capture it once when they enter, and
 * without this event a correct server-side handover would never reach the new
 * host's device.
 */
export class GameHostChangedEvent extends DomainEvent<{
  sessionId: string;
  roomId: string | null;
  hostId: string;
  previousHostId: string;
  /** Why the role moved — for the audit log and for debugging a stuck board. */
  reason: 'host_forfeited' | 'host_not_playing' | 'room_ownership_transferred';
}> {
  readonly name = GAME_EVENTS.HOST_CHANGED;
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

/**
 * The turn watchdog suspects `currentTurnUserId`'s turn is stalled and is
 * giving the room one last chance to prove otherwise (see
 * GAME_TURN_STALL_GRACE_MS) before force-advancing it. A client that's
 * actually still mid-turn should push a fresh `sync_state` move.
 */
export class GameTurnResyncRequestedEvent extends DomainEvent<{
  sessionId: string;
  currentTurnUserId: string | null;
  turnStartedAt: number;
}> {
  readonly name = GAME_EVENTS.TURN_RESYNC_REQUESTED;
}

/** The turn watchdog force-advanced a stalled turn past an unresponsive seat. */
export class GameTurnForceAdvancedEvent extends DomainEvent<{
  sessionId: string;
  roomId: string | null;
  skippedUserId: string | null;
  skippedStrikes: number;
  currentTurnUserId: string | null;
  /** Session revision after the force-advance (see `GameLiveState.rev`). */
  rev: number;
}> {
  readonly name = GAME_EVENTS.TURN_FORCE_ADVANCED;
}

/**
 * The host reported a result; settlement is withheld pending another
 * participant's confirmation (or the confirm window elapsing undisputed —
 * see GAME_RESULT_CONFIRM_SECONDS). Peer-relay games have no server-side
 * rules engine, so this is the platform's defense against a host
 * unilaterally declaring themselves the winner.
 */
export class GameResultReportedEvent extends DomainEvent<{
  sessionId: string;
  roomId: string | null;
  reportedBy: string;
  winners: string[];
  expiresAt: number;
}> {
  readonly name = GAME_EVENTS.RESULT_REPORTED;
}

/** A non-host participant disputed the reported result — settlement withheld, needs admin review. */
export class GameResultDisputedEvent extends DomainEvent<{
  sessionId: string;
  roomId: string | null;
  disputedBy: string;
  reportedBy: string;
}> {
  readonly name = GAME_EVENTS.RESULT_DISPUTED;
}
