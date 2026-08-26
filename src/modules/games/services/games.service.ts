import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  GameCode,
  GameCurrency,
  GameDefinition,
  GameLobby,
  GameLobbyStatus,
  GameMode,
  GameParticipant,
  GameParticipantStatus,
  GameSession,
  GameSessionStatus,
  GameTeam,
  GameTxnType,
  Prisma,
  WalletCurrency,
  WalletTxnReason,
} from '@prisma/client';
import type { PlatformRole } from 'src/common/constants';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { QUEUE_NAMES, type QueueName } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';

import { CacheService } from 'src/infra/redis/cache.service';
import { LockService } from 'src/infra/redis/lock.service';
import { safeEqualHex, sha256 } from 'src/modules/auth/services/hash.util';
import { walletLockKey } from 'src/modules/wallet/constants/wallet.constants';

import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import {
  CARROM_MODES,
  CARROM_TEAM_COIN_ASSIGNMENTS,
  GAME_DISCONNECT_GRACE_SECONDS,
  GAME_JOIN_CODE_ALPHABET,
  GAME_JOIN_CODE_LENGTH,
  GAME_LIVE_STATE_TTL_SECONDS,
  GAME_LOBBY_TTL_MS,
  GAME_MATCH_BUCKET_INDEX_KEY,
  GAME_MATCH_READY_INDEX_KEY,
  GAME_MAX_CONSECUTIVE_TURN_TIMEOUTS,
  GAME_MAX_SESSION_DURATION_SECONDS,
  GAME_PENDING_RESULT_INDEX_KEY,
  GAME_RESULT_CONFIRM_SECONDS,
  GAME_TURN_RESYNC_GRACE_MS,
  GAME_TURN_RESYNC_PENDING_TTL_SECONDS,
  GAME_TURN_SECONDS,
  GAME_TURN_STALL_GRACE_MS,
  GAME_WINS_LEADERBOARD_KEY,
  MATCHMAKING_PROTOCOL_VERSION,
  TEAM_2V2_CAPABLE_GAMES,
  effectiveMaxPlayers,
  gameDisconnectKey,
  gameLiveStateKey,
  gameLobbyLockKey,
  gameMatchBucketLockKey,
  gameMatchQueueKey,
  gameMatchReadyKey,
  gameMatchReadyLockKey,
  gameMatchReadyUserKey,
  gameMatchUserKey,
  gamePendingResultKey,
  gameSessionLockKey,
  gameTurnResyncPendingKey,
  gameWinningsLeaderboardKey,
  roomActiveGameLockKey,
  matchMaxRetries,
  matchQueueTtlSeconds,
  matchReadySeconds,
  matchmakingEnabled,
  type GameDisconnectPointer,
} from '../constants/games.constants';
import type { CreateLobbyDto, ListSessionsDto, UpdateGameDefinitionDto } from '../dto/games.dto';
import {
  GameCancelledEvent,
  GameForfeitEvent,
  GameHostChangedEvent,
  GameLobbyCancelledEvent,
  GameLobbyCreatedEvent,
  GameLobbyJoinedEvent,
  GameLobbyLeftEvent,
  GameLobbyMemberKickedEvent,
  GameLobbyTeamChangedEvent,
  GameLobbyMemberReadyEvent,
  GameLobbySettingsUpdatedEvent,
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
  type GameLobbyView,
} from '../events/game.events';
import type { GameActor } from '../interfaces/game-actor.interface';
import { GamesRepository } from '../repositories/games.repository';
import { AudioRoomGameAuthzService } from './audio-room-game-authz.service';
import {
  applyMove,
  canAct,
  forceAdvanceTurn,
  initLiveState,
  removeSeat,
  type GameLiveState,
} from './game-live-state';
import {
  assignTeamsAndSeats,
  expandTeamWinners,
  matchModeFor,
  requiredSize,
  type MatchCancelReason,
  type MatchType,
  type SeatAssignment,
} from './matchmaking-core';

/** Roles trusted to submit match results and force-cancel sessions. */
const ADMIN_ROLES: ReadonlySet<PlatformRole> = new Set<PlatformRole>(['SUPER_ADMIN', 'ADMIN']);

/** Result submitted by the trusted game engine (the platform never derives it). */
export interface SettleResultInput {
  sessionId: string;
  winners: string[];
  payouts: { userId: string; amount: number }[];
  resultData?: Record<string, unknown>;
  settledBy?: string | null;
}

/**
 * A host-reported result awaiting corroboration from another active
 * participant before the platform will settle it — see `reportMatchResult`.
 */
interface PendingMatchResult {
  winners: string[];
  resultData: Record<string, unknown>;
  reportedBy: string;
  reportedAt: number;
  expiresAt: number;
}

/** Outcome of a forfeit decision computed under the session lock — see `forfeit()`. */
type ForfeitDecision =
  | {
      kind: 'settle';
      winners: string[];
      resultData: Record<string, unknown>;
      seat: number;
      remainingCount: number;
    }
  | {
      kind: 'continue';
      seat: number;
      remainingCount: number;
      /**
       * Who should hold the host role now, when the forfeiter WAS the host.
       * Decided under the lock (it reads the participant roster) but published
       * outside it, like every other event `forfeit()` emits.
       */
      newHostId?: string | null;
    };

/** Per-user queue pointer (Redis JSON) — dedupe, O(1) leave, and retry carry-over. */
interface MatchQueuePointer {
  bucketKey: string;
  retries: number;
  firstQueuedAt: number;
}

/** Ephemeral ready-check state (Redis JSON). Nothing financial until finalize. */
interface ReadyCheckState {
  matchId: string;
  v: number;
  gameCode: GameCode;
  stake: number;
  matchType: MatchType;
  currency: GameCurrency;
  mode: GameMode;
  bucketKey: string;
  players: string[];
  ready: string[];
  hostId: string;
  retriesByUser: Record<string, number>;
  expiresAt: number;
  createdAt: number;
}

/**
 * Games platform (AR-11). Owns lobby matchmaking, entry-stake escrow
 * (debit-on-start / refund-on-cancel), the trusted result-settlement seam with
 * anti-cheat validation, immutable ledger + audit, leaderboards and history.
 * Per-game rules are out of scope — a game engine submits results via
 * `settleResult`; this service validates and pays out but never decides winners.
 */
@Injectable()
export class GamesService {
  private readonly logger = new Logger(GamesService.name);

  constructor(
    private readonly repo: GamesRepository,
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    private readonly cache: CacheService,
    private readonly queue: QueueService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
    private readonly authz: AudioRoomGameAuthzService,
  ) {}

  // ======================= Catalog =======================

  async recordGamePlay(actor: GameActor, gameCode: string, _resultData?: Record<string, unknown>) {
    const rawCode = (gameCode || 'CARROM').toUpperCase();
    const code = rawCode in GameCode ? (rawCode as GameCode) : GameCode.CARROM;
    await this.bus.publish(
      new GameSettledEvent({
        sessionId: `play-${actor.id}-${Date.now()}`,
        gameCode: code,
        roomId: null,
        currency: GameCurrency.FREE,
        potAmount: 0,
        payoutTotal: 0,
        rakeAmount: 0,
        winners: [actor.id],
        payouts: [{ userId: actor.id, amount: 0 }],
        participants: [actor.id],
      }),
    );
    return { ok: true, gameCode: code };
  }

  async listCatalog(includeDisabled = false): Promise<unknown[]> {
    const defs = await this.repo.listDefinitions(!includeDisabled);
    return defs.map((d) => this.definitionView(d));
  }

  async updateDefinition(
    actor: GameActor,
    code: GameCode,
    dto: UpdateGameDefinitionDto,
  ): Promise<unknown> {
    this.assertAdmin(actor);
    const def = await this.repo.getDefinitionByCode(code);
    if (!def) throw this.notFound(ERROR_CODES.GAME_NOT_FOUND, 'Game not found.');
    const minPlayers = dto.minPlayers ?? def.minPlayers;
    const maxPlayers = dto.maxPlayers ?? def.maxPlayers;
    const minStake = dto.minStake !== undefined ? BigInt(dto.minStake) : def.minStake;
    const maxStake = dto.maxStake !== undefined ? BigInt(dto.maxStake) : def.maxStake;
    if (minPlayers > maxPlayers || minStake > maxStake) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'min values cannot exceed max values.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const updated = await this.repo.updateDefinition(code, {
      minPlayers,
      maxPlayers,
      minStake,
      maxStake,
      houseRakeBps: dto.houseRakeBps ?? def.houseRakeBps,
      enabled: dto.enabled ?? def.enabled,
      updatedBy: actor.id,
    });
    return this.definitionView(updated);
  }

  // ======================= Lobbies =======================

  async createLobby(actor: GameActor, dto: CreateLobbyDto): Promise<unknown> {
    if (dto.roomId) {
      // UX-level early check — the authoritative "one active game per room"
      // gate is re-checked under a room lock at start time (see
      // startSessionFromLobby); this just gives the room's host immediate
      // feedback instead of a lobby that can never be started.
      await this.authz.assertCanStartBoardGame(dto.roomId, actor.id);
      if (await this.repo.findActiveSessionForRoom(dto.roomId)) {
        throw this.conflict(
          ERROR_CODES.GAME_ROOM_ALREADY_ACTIVE,
          'This room already has an active game.',
        );
      }
    }
    const def = await this.requireEnabledDefinition(dto.gameCode);
    this.assertStakeInRange(def, dto.stake);
    const mode = dto.mode ?? GameMode.CLASSIC;
    if (mode === GameMode.TEAM_2V2) this.assert2v2Supported(dto.gameCode);

    const carrom = this.enforceCarromSettings(
      mode,
      dto.carromMode ?? (mode === GameMode.TEAM_2V2 ? 'classic' : undefined),
      dto.teamCoinAssignment ?? (mode === GameMode.TEAM_2V2 ? 'team_a_white' : undefined),
    );

    const code = await this.generateJoinCode();
    const lobby = await this.repo.createLobby({
      definitionId: def.id,
      code,
      hostId: actor.id,
      roomId: dto.roomId ?? null,
      category: def.category,
      currency: def.currency,
      stake: BigInt(dto.stake),
      maxPlayers: effectiveMaxPlayers(def.code, mode, def.maxPlayers),
      mode,
      carromMode: carrom.carromMode,
      teamCoinAssignment: carrom.teamCoinAssignment,
      isPrivate: dto.isPrivate ?? false,
      passwordHash: dto.password ? sha256(dto.password) : null,
      status: GameLobbyStatus.OPEN,
      expiresAt: new Date(Date.now() + GAME_LOBBY_TTL_MS),
      createdBy: actor.id,
    });
    const initialTeam = lobby.mode === GameMode.TEAM_2V2 ? GameTeam.A : undefined;
    await this.repo.addMember(lobby.id, actor.id, initialTeam);
    await this.repo.logEvent({
      lobbyId: lobby.id,
      userId: actor.id,
      action: 'lobby.created',
      detail: { gameCode: def.code, stake: dto.stake },
    });

    const view = await this.lobbyView(lobby, def.code);
    await this.bus.publish(new GameLobbyCreatedEvent(view));
    return view;
  }

  async joinLobby(actor: GameActor, code: string, password?: string): Promise<unknown> {
    const lobby = await this.requireLobby(code);
    if (lobby.status !== GameLobbyStatus.OPEN) {
      throw this.conflict(ERROR_CODES.GAME_LOBBY_NOT_OPEN, 'This lobby is not open.');
    }
    return this.locks.withLock(gameLobbyLockKey(lobby.id), async () => {
      const fresh = await this.repo.getLobbyById(lobby.id);
      if (!fresh || fresh.status !== GameLobbyStatus.OPEN) {
        throw this.conflict(ERROR_CODES.GAME_LOBBY_NOT_OPEN, 'This lobby is not open.');
      }
      // Audio-room integration: a lobby bound to an audio room may only be
      // joined by current members of that room — a user in another room (or a
      // stranger) who obtains the join code must not gain access to a game
      // hosted inside a private room. Checked before the password so a
      // non-member learns nothing about the password.
      if (fresh.roomId && !(await this.authz.isMember(fresh.roomId, actor.id))) {
        throw new BusinessException(
          ERROR_CODES.NOT_ROOM_MEMBER,
          'You must be a member of the hosting room to join this lobby.',
          HttpStatus.FORBIDDEN,
        );
      }
      if (fresh.passwordHash && !safeEqualHex(sha256(password ?? ''), fresh.passwordHash)) {
        throw this.conflict(ERROR_CODES.GAME_LOBBY_BAD_PASSWORD, 'Incorrect lobby password.');
      }
      if (await this.repo.getMember(fresh.id, actor.id)) {
        throw this.conflict(ERROR_CODES.GAME_ALREADY_IN_LOBBY, 'You are already in this lobby.');
      }
      if ((await this.repo.countMembers(fresh.id)) >= fresh.maxPlayers) {
        throw this.conflict(ERROR_CODES.GAME_LOBBY_FULL, 'This lobby is full.');
      }
      await this.assertCanAfford(actor.id, fresh.currency, fresh.stake);
      let team: GameTeam | undefined;
      if (fresh.mode === GameMode.TEAM_2V2) {
        const members = await this.repo.listMembersWithTeams(fresh.id);
        const aCount = members.filter((m) => m.team === GameTeam.A).length;
        const bCount = members.filter((m) => m.team === GameTeam.B).length;
        team = aCount <= bCount ? GameTeam.A : GameTeam.B;
      }
      await this.repo.addMember(fresh.id, actor.id, team);
      await this.repo.logEvent({ lobbyId: fresh.id, userId: actor.id, action: 'lobby.joined' });

      const gameCode = await this.gameCodeOf(fresh.definitionId);
      const view = await this.lobbyView(fresh, gameCode);
      await this.bus.publish(new GameLobbyJoinedEvent({ ...view, userId: actor.id }));
      return view;
    });
  }

  async leaveLobby(actor: GameActor, code: string): Promise<{ left: boolean; disbanded: boolean }> {
    const lobby = await this.requireLobby(code);
    if (lobby.status !== GameLobbyStatus.OPEN) {
      throw this.conflict(ERROR_CODES.GAME_LOBBY_NOT_OPEN, 'This lobby is not open.');
    }
    return this.locks.withLock(gameLobbyLockKey(lobby.id), async () => {
      const fresh = await this.repo.getLobbyById(lobby.id);
      if (!fresh || fresh.status !== GameLobbyStatus.OPEN) {
        throw this.conflict(ERROR_CODES.GAME_LOBBY_NOT_OPEN, 'This lobby is not open.');
      }
      // The host leaving disbands the lobby entirely.
      if (fresh.hostId === actor.id) {
        await this.repo.markLobbyClosed(fresh.id, GameLobbyStatus.CANCELLED, actor.id);
        await this.repo.logEvent({
          lobbyId: fresh.id,
          userId: actor.id,
          action: 'lobby.disbanded',
        });
        await this.bus.publish(
          new GameLobbyCancelledEvent({
            lobbyId: fresh.id,
            code: fresh.code,
            reason: 'host_left',
          }),
        );
        return { left: true, disbanded: true };
      }
      if (!(await this.repo.getMember(fresh.id, actor.id))) {
        throw this.conflict(ERROR_CODES.GAME_NOT_IN_LOBBY, 'You are not in this lobby.');
      }
      await this.repo.removeMember(fresh.id, actor.id);
      await this.repo.logEvent({ lobbyId: fresh.id, userId: actor.id, action: 'lobby.left' });
      const members = await this.repo.listMemberIds(fresh.id);
      await this.bus.publish(
        new GameLobbyLeftEvent({ lobbyId: fresh.id, code: fresh.code, userId: actor.id, members }),
      );
      return { left: true, disbanded: false };
    });
  }

  /**
   * Automatically transfers host ownership of an OPEN lobby to the next oldest
   * human member when the original host has been offline for 60 seconds.
   */
  async transferLobbyHost(lobbyId: string, expectedOldHostId: string): Promise<void> {
    await this.locks.withLock(gameLobbyLockKey(lobbyId), async () => {
      const fresh = await this.repo.getLobbyById(lobbyId);
      if (!fresh || fresh.status !== GameLobbyStatus.OPEN || fresh.hostId !== expectedOldHostId) {
        return;
      }

      const rows = await this.repo.listMembersWithTeams(fresh.id);
      const candidates = rows
        .filter((m) => !m.isBot && m.userId !== expectedOldHostId)
        .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());

      if (candidates.length === 0) {
        // No remaining human players — close/disband the lobby
        await this.repo.markLobbyClosed(fresh.id, GameLobbyStatus.CANCELLED, expectedOldHostId);
        await this.repo.logEvent({
          lobbyId: fresh.id,
          userId: expectedOldHostId,
          action: 'lobby.disbanded_timeout',
        });
        await this.bus.publish(
          new GameLobbyCancelledEvent({
            lobbyId: fresh.id,
            code: fresh.code,
            reason: 'host_offline_timeout',
          }),
        );
        return;
      }

      const newHostId = candidates[0].userId;
      await this.repo.updateLobbyHost(fresh.id, newHostId);
      await this.repo.logEvent({
        lobbyId: fresh.id,
        userId: newHostId,
        action: 'lobby.host_transferred',
        detail: { oldHostId: expectedOldHostId, newHostId },
      });

      const updatedLobby = { ...fresh, hostId: newHostId };
      const gameCode = await this.gameCodeOf(fresh.definitionId);
      const view = await this.lobbyView(updatedLobby, gameCode);
      await this.bus.publish(new GameLobbyJoinedEvent({ ...view, userId: newHostId }));
    });
  }

  /** Host removes a member from an OPEN lobby (to leave yourself, use close/leave). */
  async kickMember(actor: GameActor, code: string, targetUserId: string): Promise<unknown> {
    const lobby = await this.requireLobby(code);
    this.assertHost(lobby.hostId, actor.id, 'Only the host can kick members.');
    if (targetUserId === actor.id) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'The host cannot kick themselves — close the lobby instead.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.locks.withLock(gameLobbyLockKey(lobby.id), async () => {
      const fresh = await this.repo.getLobbyById(lobby.id);
      if (!fresh || fresh.status !== GameLobbyStatus.OPEN) {
        throw this.conflict(ERROR_CODES.GAME_LOBBY_NOT_OPEN, 'This lobby is not open.');
      }
      if (!(await this.repo.getMember(fresh.id, targetUserId))) {
        throw this.conflict(ERROR_CODES.GAME_NOT_LOBBY_MEMBER, 'That user is not in this lobby.');
      }
      await this.repo.removeMember(fresh.id, targetUserId);
      await this.repo.logEvent({
        lobbyId: fresh.id,
        userId: targetUserId,
        action: 'lobby.kicked',
        detail: { by: actor.id },
      });
      const members = await this.repo.listMemberIds(fresh.id);
      await this.bus.publish(
        new GameLobbyMemberKickedEvent({
          lobbyId: fresh.id,
          code: fresh.code,
          userId: targetUserId,
          members,
        }),
      );
      return { kicked: targetUserId, members };
    });
  }

  /** Host closes (disbands) an OPEN lobby. */
  async closeLobby(actor: GameActor, code: string): Promise<{ closed: boolean }> {
    const lobby = await this.requireLobby(code);
    this.assertHost(lobby.hostId, actor.id, 'Only the host can close the lobby.');
    return this.locks.withLock(gameLobbyLockKey(lobby.id), async () => {
      const fresh = await this.repo.getLobbyById(lobby.id);
      if (!fresh || fresh.status !== GameLobbyStatus.OPEN) {
        throw this.conflict(ERROR_CODES.GAME_LOBBY_NOT_OPEN, 'This lobby is not open.');
      }
      await this.repo.markLobbyClosed(fresh.id, GameLobbyStatus.CANCELLED, actor.id);
      await this.repo.logEvent({ lobbyId: fresh.id, userId: actor.id, action: 'lobby.closed' });
      await this.bus.publish(
        new GameLobbyCancelledEvent({ lobbyId: fresh.id, code: fresh.code, reason: 'host_closed' }),
      );
      return { closed: true };
    });
  }

  /**
   * Closes the room's still-open (pre-start) room-bound lobby when its audio
   * room ends. An active board-game session is aborted separately (the room-end
   * lifecycle listener → `abortSession`); a lobby that never started would
   * otherwise stay OPEN until its TTL sweep — still joinable-looking to members
   * of the ended room but permanently unstartable (start requires a live room).
   * No stake is escrowed until session start, so this is just the status flip +
   * the same lobby_cancelled fan-out the host-close path uses. A no-op when the
   * room has no open room-bound lobby (or it raced to STARTED/closed).
   */
  async closeRoomBoundLobby(roomId: string): Promise<void> {
    const lobby = await this.repo.findOpenLobbyForRoom(roomId);
    if (!lobby) return;
    await this.locks.withLock(gameLobbyLockKey(lobby.id), async () => {
      const fresh = await this.repo.getLobbyById(lobby.id);
      if (!fresh || fresh.status !== GameLobbyStatus.OPEN) return;
      await this.repo.markLobbyClosed(fresh.id, GameLobbyStatus.CANCELLED, null);
      await this.repo.logEvent({
        lobbyId: fresh.id,
        action: 'lobby.closed_room_ended',
      });
      await this.bus.publish(
        new GameLobbyCancelledEvent({
          lobbyId: fresh.id,
          code: fresh.code,
          reason: 'room_ended',
        }),
      );
    });
  }

  /**
   * Re-points the room's room-bound board-game ownership after an audio-room
   * OWNERSHIP_TRANSFERRED: the new room owner becomes the host of any still-open
   * room-bound lobby (so they can start it) and of any active board-game session
   * (so they can report/cancel it). Casino windows are deliberately skipped —
   * their host re-point is handled by the casino module's own listener
   * (`RoomCasinoWindowService.onOwnerChanged`), which re-reads the same session.
   */
  /**
   * The participant best suited to hold the host role, or null if nobody is.
   *
   * The host is the client that drives every BOT seat and reports the winner,
   * so it must be a HUMAN who is still PLAYING. A bot has no device to run the
   * driving loop on, and a departed player's client is gone — either choice
   * leaves the bots frozen and the result unreportable, which is exactly the
   * "the game got stuck" report.
   *
   * `preferred` wins if they qualify (the new room owner, when they happen to
   * be in the match); otherwise the first eligible seat in join order, which
   * is stable across callers so two racing handovers agree.
   */
  private pickSessionHost(
    participants: GameParticipant[],
    opts: { preferred?: string; exclude?: string } = {},
  ): string | null {
    const eligible = participants.filter(
      (p) =>
        !p.isBot &&
        p.status === GameParticipantStatus.PLAYING &&
        p.userId !== opts.exclude,
    );
    if (opts.preferred && eligible.some((p) => p.userId === opts.preferred)) {
      return opts.preferred;
    }
    return eligible[0]?.userId ?? null;
  }

  /**
   * Move the host role to `newHostId` and tell the room. No-op when the role
   * is already there or there is nobody to give it to.
   *
   * Clients capture `hostId` when they enter and never re-read it, so the
   * event is not optional bookkeeping — without it the new host's device never
   * starts driving the bot seats and the board stays frozen regardless of what
   * the database says.
   */
  private async handOverHost(
    session: GameSession,
    newHostId: string | null,
    reason: 'host_forfeited' | 'host_not_playing' | 'room_ownership_transferred',
  ): Promise<void> {
    if (!newHostId || newHostId === session.hostId) return;
    const previousHostId = session.hostId;
    await this.repo.updateSessionHost(session.id, newHostId);
    await this.repo.logEvent({
      sessionId: session.id,
      userId: newHostId,
      action: 'session.host_updated',
      detail: { reason, previousHostId },
    });
    await this.bus.publish(
      new GameHostChangedEvent({
        sessionId: session.id,
        roomId: session.roomId,
        hostId: newHostId,
        previousHostId,
        reason,
      }),
    );
  }

  async repointRoomGameHost(roomId: string, newOwnerId: string): Promise<void> {
    const session = await this.repo.findActiveSessionForRoom(roomId);
    if (session && session.code !== GameCode.GREEDY_FOOD && session.code !== GameCode.LUCKY_FRUIT) {
      // The new ROOM owner is not necessarily in the match. Handing them the
      // SESSION host role anyway put it on someone with no board — nobody to
      // drive the bot seats, nobody able to report the winner — which is the
      // "the host who created the room isn't playing and it gets stuck" case.
      // The role goes to them only if they are actually playing; otherwise it
      // stays put (if the current host still is) or moves to someone who is.
      const participants = await this.repo.listParticipants(session.id);
      const currentHostStillPlaying = participants.some(
        (p) =>
          p.userId === session.hostId &&
          !p.isBot &&
          p.status === GameParticipantStatus.PLAYING,
      );
      const next = this.pickSessionHost(participants, { preferred: newOwnerId });
      if (!currentHostStillPlaying || next === newOwnerId) {
        await this.handOverHost(session, next, 'room_ownership_transferred');
      }
    }
    const lobby = await this.repo.findOpenLobbyForRoom(roomId);
    if (lobby) {
      await this.repo.updateLobbyHost(lobby.id, newOwnerId);
      await this.repo.logEvent({
        lobbyId: lobby.id,
        userId: newOwnerId,
        action: 'lobby.host_updated',
        detail: { reason: 'room_ownership_transferred' },
      });
    }
  }

  /**
   * Validates carromMode and teamCoinAssignment values.
   * Throws a 400 BadRequest if either is unknown. Call before persisting settings
   * or starting a session to guard against malformed API payloads.
   */
  private validateCarromSettings(carromMode?: string, teamCoinAssignment?: string): void {
    if (carromMode !== undefined && !(CARROM_MODES as readonly string[]).includes(carromMode)) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        `Invalid carromMode '${carromMode}'. Allowed: ${CARROM_MODES.join(', ')}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      teamCoinAssignment !== undefined &&
      !(CARROM_TEAM_COIN_ASSIGNMENTS as readonly string[]).includes(teamCoinAssignment)
    ) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        `Invalid teamCoinAssignment '${teamCoinAssignment}'. Allowed: ${CARROM_TEAM_COIN_ASSIGNMENTS.join(', ')}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Mode-aware Carrom settings guard. Solo (CLASSIC) matches always use
   * individual scoring and can never have team coin assignments — any
   * client-provided value for these fields is ignored and overridden.
   * Team (TEAM_2V2) matches must specify a valid, mutually consistent pair;
   * invalid or missing values are rejected outright rather than defaulted,
   * since silently guessing a team's coin colour would be a gameplay bug.
   * Returns the enforced values to persist — never the raw client input.
   */
  private enforceCarromSettings(
    mode: GameMode,
    carromMode?: string | null,
    teamCoinAssignment?: string | null,
  ): { carromMode: string; teamCoinAssignment: string | null } {
    if (mode === GameMode.CLASSIC) {
      return { carromMode: 'open_score', teamCoinAssignment: null };
    }
    const resolvedCarromMode = carromMode ?? undefined;
    const resolvedAssignment = teamCoinAssignment ?? undefined;
    this.validateCarromSettings(resolvedCarromMode, resolvedAssignment);
    if (!resolvedCarromMode || !(CARROM_MODES as readonly string[]).includes(resolvedCarromMode)) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        `Team matches require a carromMode of ${CARROM_MODES.join(' or ')}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      !resolvedAssignment ||
      !(CARROM_TEAM_COIN_ASSIGNMENTS as readonly string[]).includes(resolvedAssignment)
    ) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        `Team matches require a teamCoinAssignment of ${CARROM_TEAM_COIN_ASSIGNMENTS.join(' or ')}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return { carromMode: resolvedCarromMode, teamCoinAssignment: resolvedAssignment };
  }

  /** Host edits OPEN-lobby settings (stake / maxPlayers / password / carromMode / teamCoinAssignment). */
  async updateLobbySettings(
    actor: GameActor,
    code: string,
    dto: {
      stake?: number;
      maxPlayers?: number;
      password?: string;
      carromMode?: string;
      teamCoinAssignment?: string;
    },
  ): Promise<unknown> {
    const lobby = await this.requireLobby(code);
    this.assertHost(lobby.hostId, actor.id, 'Only the host can edit lobby settings.');
    return this.locks.withLock(gameLobbyLockKey(lobby.id), async () => {
      const fresh = await this.repo.getLobbyById(lobby.id);
      if (!fresh || fresh.status !== GameLobbyStatus.OPEN) {
        throw this.conflict(ERROR_CODES.GAME_LOBBY_NOT_OPEN, 'This lobby is not open.');
      }
      const def = await this.requireEnabledDefinition(await this.gameCodeOf(fresh.definitionId));
      const data: Prisma.GameLobbyUncheckedUpdateInput = { updatedBy: actor.id };
      if (dto.stake !== undefined) {
        this.assertStakeInRange(def, dto.stake);
        data.stake = BigInt(dto.stake);
      }
      if (dto.maxPlayers !== undefined) {
        const memberCount = await this.repo.countMembers(fresh.id);
        if (dto.maxPlayers < memberCount || dto.maxPlayers > def.maxPlayers) {
          throw new BusinessException(
            ERROR_CODES.VALIDATION_ERROR,
            `maxPlayers must be between ${memberCount} and ${def.maxPlayers}.`,
            HttpStatus.BAD_REQUEST,
          );
        }
        data.maxPlayers = dto.maxPlayers;
      }
      if (dto.password !== undefined) {
        data.passwordHash = dto.password ? sha256(dto.password) : null;
      }
      // Validate carrom-specific settings before persisting.
      this.validateCarromSettings(dto.carromMode, dto.teamCoinAssignment);
      if (fresh.mode === GameMode.CLASSIC) {
        data.carromMode = 'open_score';
        data.teamCoinAssignment = null;
      } else {
        if (dto.carromMode !== undefined) {
          data.carromMode = dto.carromMode;
        }
        if (dto.teamCoinAssignment !== undefined) {
          data.teamCoinAssignment = dto.teamCoinAssignment;
        }
      }
      const updated = await this.repo.updateLobby(fresh.id, data);
      await this.repo.logEvent({
        lobbyId: fresh.id,
        userId: actor.id,
        action: 'lobby.settings_updated',
        detail: {
          stake: dto.stake,
          maxPlayers: dto.maxPlayers,
          password: dto.password !== undefined,
          carromMode: dto.carromMode,
          teamCoinAssignment: dto.teamCoinAssignment,
        },
      });
      const view = await this.lobbyView(updated, await this.gameCodeOf(updated.definitionId));
      await this.bus.publish(new GameLobbySettingsUpdatedEvent(view));
      return view;
    });
  }

  /** Host adds a bot seat to an OPEN lobby. Bots fill seats but never stake. */
  async addBot(
    actor: GameActor,
    code: string,
    opts: { name?: string; team?: GameTeam },
  ): Promise<unknown> {
    const lobby = await this.requireLobby(code);
    this.assertHost(lobby.hostId, actor.id, 'Only the host can add bots.');
    return this.locks.withLock(gameLobbyLockKey(lobby.id), async () => {
      const fresh = await this.repo.getLobbyById(lobby.id);
      if (!fresh || fresh.status !== GameLobbyStatus.OPEN) {
        throw this.conflict(ERROR_CODES.GAME_LOBBY_NOT_OPEN, 'This lobby is not open.');
      }
      // Bots are only allowed in friendly (no-stake) matches. A bet match's pot
      // must consist solely of real player stakes — a bot holds no wallet and
      // stakes nothing, so it can never contribute to (or legitimately win) a pot.
      if (Number(fresh.stake) > 0) {
        throw new BusinessException(
          ERROR_CODES.VALIDATION_ERROR,
          'Bots are only allowed in friendly matches — a bet match requires real players.',
          HttpStatus.BAD_REQUEST,
        );
      }
      if ((await this.repo.countMembers(fresh.id)) >= fresh.maxPlayers) {
        throw this.conflict(ERROR_CODES.GAME_LOBBY_FULL, 'This lobby is full.');
      }
      const botId = randomUUID();
      const botName = opts.name ?? `Bot ${botId.slice(0, 4)}`;
      let team = opts.team;
      if (!team && fresh.mode === GameMode.TEAM_2V2) {
        const members = await this.repo.listMembersWithTeams(fresh.id);
        const aCount = members.filter((m) => m.team === GameTeam.A).length;
        const bCount = members.filter((m) => m.team === GameTeam.B).length;
        team = aCount <= bCount ? GameTeam.A : GameTeam.B;
      }
      await this.repo.addBotMember(fresh.id, botId, botName, team);
      await this.repo.logEvent({
        lobbyId: fresh.id,
        userId: botId,
        action: 'lobby.bot_added',
        detail: { botName },
      });
      const view = await this.lobbyView(fresh, await this.gameCodeOf(fresh.definitionId));
      await this.bus.publish(new GameLobbyJoinedEvent({ ...view, userId: botId }));
      return { botId, botName };
    });
  }

  async startLobby(actor: GameActor, code: string): Promise<unknown> {
    const lobby = await this.requireLobby(code);
    if (lobby.hostId !== actor.id) {
      throw new BusinessException(
        ERROR_CODES.GAME_NOT_HOST,
        'Only the lobby host can start the game.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (lobby.status !== GameLobbyStatus.OPEN) {
      throw this.conflict(ERROR_CODES.GAME_LOBBY_NOT_OPEN, 'This lobby is not open.');
    }
    return this.startSessionFromLobby(lobby.id, actor.id);
  }

  /**
   * The single authoritative session-creation + escrow path. Reached two ways:
   * the REST host-start (`startLobby`, which asserts the caller is the host) and
   * the matchmaking finalize (which trusts the first-queued host). Escrows every
   * stake with idempotency keys, refunds + aborts on any failed debit, fixes the
   * pot, and publishes GameStartedEvent. For TEAM_2V2 it freezes team + seat
   * assignment so the engines read the positional {0,2}/{1,3} split. Matchmaking
   * does NOT get a parallel start implementation — it calls this.
   */
  async startSessionFromLobby(lobbyId: string, actorId: string): Promise<unknown> {
    return this.locks.withLock(gameLobbyLockKey(lobbyId), async () => {
      const fresh = await this.repo.getLobbyById(lobbyId);
      if (!fresh || fresh.status !== GameLobbyStatus.OPEN) {
        throw this.conflict(ERROR_CODES.GAME_LOBBY_NOT_OPEN, 'This lobby is not open.');
      }
      const def = await this.requireEnabledDefinition(await this.gameCodeOf(fresh.definitionId));
      const members = await this.repo.listMemberIds(fresh.id);
      if (members.length < def.minPlayers) {
        throw new BusinessException(
          ERROR_CODES.GAME_INSUFFICIENT_PLAYERS,
          `This game needs at least ${def.minPlayers} players.`,
          HttpStatus.CONFLICT,
        );
      }
      if (members.length > fresh.maxPlayers) {
        throw this.conflict(ERROR_CODES.GAME_LOBBY_FULL, 'This lobby exceeds the player limit.');
      }
      // Final Carrom settings guard, run unconditionally right before the
      // session is created — catches anything that slipped through an earlier
      // path (direct DB edit, a race on an old lobby row, etc). Solo lobbies
      // are forced to open_score/null regardless of what's stored; team
      // lobbies must already hold a valid, complete pair or session creation
      // is aborted rather than started with inconsistent game state.
      const carrom = this.enforceCarromSettings(
        fresh.mode ?? GameMode.CLASSIC,
        fresh.carromMode ?? undefined,
        fresh.teamCoinAssignment ?? undefined,
      );

      // Bots fill seats but hold no wallet: they stake 0, are skipped at escrow,
      // and the pot is the sum of HUMAN stakes only.
      const memberRows = await this.repo.listMembersWithTeams(fresh.id);
      const botIds = new Set(memberRows.filter((m) => m.isBot).map((m) => m.userId));
      const humanCount = members.length - botIds.size;

      // Freeze seat order (CLASSIC = join order; TEAM_2V2 = positional A/B split).
      const seats = this.resolveSeats(fresh, members, memberRows);

      // Create the session + participants atomically (either both land or
      // neither does — otherwise a failure between the two calls could leave
      // an ACTIVE session with zero participants and no stake escrowed,
      // self-healing only once the 15-minute stale sweep eventually catches
      // it), then escrow each stake. Any failed debit refunds everything
      // already taken and aborts the session.
      const createSessionRow = () =>
        this.repo.runInTransaction(async (tx) => {
          const created = await this.repo.createSession(
            {
              definitionId: def.id,
              code: def.code,
              lobbyId: fresh.id,
              joinCode: fresh.code,
              hostId: fresh.hostId,
              roomId: fresh.roomId,
              category: def.category,
              currency: def.currency,
              stake: fresh.stake,
              mode: fresh.mode,
              carromMode: carrom.carromMode,
              teamCoinAssignment: carrom.teamCoinAssignment,
              playerCount: members.length,
              status: GameSessionStatus.ACTIVE,
              createdBy: actorId,
            },
            tx,
          );
          await this.repo.createParticipants(
            seats.map((s) => ({
              sessionId: created.id,
              definitionId: def.id,
              userId: s.userId,
              seat: s.seat,
              team: s.team,
              isBot: botIds.has(s.userId),
              stake: botIds.has(s.userId) ? 0n : fresh.stake,
            })),
            tx,
          );
          return created;
        });

      // Audio-room integration: re-check host authority + "one active game per
      // room" against a fresh read, under a room-scoped lock held through
      // session creation — the authoritative gate (the create-lobby-time check
      // is UX-only). No `roomId` (the overwhelming majority of lobbies) skips
      // this entirely — zero behavior change for non-room-bound games.
      const session = fresh.roomId
        ? await this.locks.withLock(roomActiveGameLockKey(fresh.roomId), async () => {
            await this.authz.assertCanStartBoardGame(fresh.roomId as string, actorId);
            if (await this.repo.findActiveSessionForRoom(fresh.roomId as string)) {
              throw this.conflict(
                ERROR_CODES.GAME_ROOM_ALREADY_ACTIVE,
                'This room already has an active game.',
              );
            }
            return createSessionRow();
          })
        : await createSessionRow();
      const participants = await this.repo.listParticipants(session.id);

      const escrowed: GameParticipant[] = [];
      try {
        for (const p of participants) {
          // bots don't stake; friendly (stake 0) matches escrow nothing.
          if (p.isBot || Number(session.stake) === 0) continue;
          const debit = await this.wallet.debit({
            userId: p.userId,
            currency: this.walletCurrency(session.currency),
            amount: Number(session.stake),
            reason: WalletTxnReason.GAME_STAKE,
            idempotencyKey: `game-stake:${session.id}:${p.userId}`,
            referenceType: 'game_session',
            referenceId: session.id,
            metadata: { gameCode: def.code },
            actorId: p.userId,
          });
          // Record the successful debit BEFORE the follow-up ledger/participant
          // writes: if either of those throws, this participant's stake was still
          // actually taken from their wallet, so it must still be refunded below.
          escrowed.push(p);
          await this.repo.createTransaction({
            sessionId: session.id,
            participantId: p.id,
            userId: p.userId,
            type: GameTxnType.STAKE,
            currency: session.currency,
            amount: session.stake,
            walletTxnId: debit.transactionId,
            idempotencyKey: `game-stake:${session.id}:${p.userId}`,
          });
          await this.repo.updateParticipant(p.id, { stakeTxnId: debit.transactionId });
        }
      } catch (err) {
        await this.refundParticipants(session, escrowed);
        await this.repo.closeSession(session.id, GameSessionStatus.ABORTED, actorId);
        await this.repo.logEvent({
          sessionId: session.id,
          lobbyId: fresh.id,
          action: 'session.aborted',
          detail: { reason: 'stake_failed', staked: escrowed.length },
        });
        throw err;
      }

      const potAmount = session.stake * BigInt(humanCount);
      await this.repo.setSessionPot(session.id, potAmount);
      await this.repo.markLobbyStarted(fresh.id, session.id, actorId);
      await this.repo.logEvent({
        sessionId: session.id,
        lobbyId: fresh.id,
        userId: actorId,
        action: 'session.started',
        detail: {
          potAmount: Number(potAmount),
          players: members.length,
          bots: botIds.size,
          mode: fresh.mode,
        },
      });

      await this.bus.publish(
        new GameStartedEvent({
          sessionId: session.id,
          lobbyId: fresh.id,
          joinCode: fresh.code,
          gameCode: def.code,
          roomId: session.roomId,
          currency: session.currency,
          stake: Number(session.stake),
          potAmount: Number(potAmount),
          participants: members,
          carromMode: carrom.carromMode,
          teamCoinAssignment: carrom.teamCoinAssignment,
        }),
      );
      await this.enqueueBestEffort(QUEUE_NAMES.ANALYTICS_PROCESSING, 'game.started', {
        sessionId: session.id,
        gameCode: def.code,
        players: members.length,
        potAmount: Number(potAmount),
      });
      return this.sessionView({ ...session, potAmount }, participants);
    });
  }

  /** Freeze seat + team layout for a session. TEAM_2V2 uses the positional split. */
  private resolveSeats(
    lobby: GameLobby,
    members: string[],
    memberRows: { userId: string; team: GameTeam | null }[],
  ): SeatAssignment[] {
    if (lobby.mode !== GameMode.TEAM_2V2) {
      return members.map((userId, seat) => ({ userId, team: null, seat }));
    }
    const picks = new Map<string, GameTeam>();
    for (const m of memberRows) if (m.team) picks.set(m.userId, m.team);
    const result = assignTeamsAndSeats(members, picks, GameMode.TEAM_2V2);
    if (!result.ok) {
      if (result.error === 'WRONG_PLAYER_COUNT') {
        throw new BusinessException(
          ERROR_CODES.GAME_INSUFFICIENT_PLAYERS,
          'A 2v2 match needs exactly 4 players.',
          HttpStatus.CONFLICT,
        );
      }
      throw this.conflict(ERROR_CODES.GAME_TEAM_UNBALANCED, 'Teams must be balanced 2 v 2.');
    }
    return result.seats;
  }

  // ======================= Cancel / settle =======================

  async cancelSession(actor: GameActor, sessionId: string): Promise<{ refunded: string[] }> {
    const session = await this.repo.getSession(sessionId);
    if (!session) throw this.notFound(ERROR_CODES.GAME_SESSION_NOT_FOUND, 'Session not found.');
    if (session.hostId !== actor.id && !this.isAdmin(actor)) {
      throw new BusinessException(
        ERROR_CODES.GAME_NOT_AUTHORIZED,
        'Only the host or an admin can cancel this session.',
        HttpStatus.FORBIDDEN,
      );
    }
    // The host is not a neutral role (in matchmaking it's just whichever
    // player was first-queued), so a blanket "cancel for a full refund" is an
    // asymmetric escape hatch: a host about to lose could otherwise void the
    // match and get their stake back, while every other participant's only
    // exit (forfeit) costs them theirs. Once gameplay has actually started —
    // any move relayed — the host can no longer unilaterally cancel; they
    // must forfeit (or an admin can still force-cancel for genuine
    // operational reasons).
    if (!this.isAdmin(actor)) {
      const state = await this.loadOrInitLiveState(session);
      if (state.moves.length > 0) {
        throw new BusinessException(
          ERROR_CODES.GAME_HAS_MOVES,
          'This match is already in progress — forfeit instead of cancelling.',
          HttpStatus.CONFLICT,
        );
      }
    }
    return this.abortSession(sessionId, GameSessionStatus.CANCELLED, actor.id, 'host_cancel');
  }

  /** Trusted settlement seam — validates and pays out; never decides winners. */
  async settleResult(input: SettleResultInput): Promise<unknown> {
    const session = await this.repo.getSession(input.sessionId);
    if (!session) throw this.notFound(ERROR_CODES.GAME_SESSION_NOT_FOUND, 'Session not found.');

    // A longer TTL than the default 10s: this critical section does a
    // sequential wallet credit + ledger write per winner inside a DB
    // transaction, so with several winners under DB contention it can run
    // long enough for the default TTL to expire mid-operation, silently
    // freeing the lock for a concurrent retry to double-settle. The
    // idempotency keys and the getMatchResult check above are defense in
    // depth, not a substitute for actually holding the lock for the duration.
    return this.locks.withLock(
      gameSessionLockKey(session.id),
      async () => {
        const fresh = await this.repo.getSession(session.id);
        if (!fresh || fresh.status !== GameSessionStatus.ACTIVE) {
          throw this.conflict(ERROR_CODES.GAME_SESSION_NOT_ACTIVE, 'Session is not active.');
        }
        if (await this.repo.getMatchResult(fresh.id)) {
          throw this.conflict(ERROR_CODES.GAME_ALREADY_SETTLED, 'Session is already settled.');
        }

        const participants = await this.repo.listParticipants(fresh.id);
        const participantIds = new Set(participants.map((p) => p.userId));
        const payoutMap = this.validateSettlement(fresh, participants, participantIds, input);
        const payoutTotal = [...payoutMap.values()].reduce((a, b) => a + b, 0);
        const rakeAmount = Number(fresh.potAmount) - payoutTotal;

        // Credit winners + record the ledger + close out every participant + flip
        // the session to COMPLETED as ONE atomic DB transaction (idempotency keys
        // still make a safe-to-retry replay of the credit itself a no-op): a crash
        // or error partway through must never leave a half-settled session — one
        // that's already paid a winner but never reached COMPLETED — since a retry
        // could then re-attempt the ledger insert and collide with its own
        // unique idempotency key. Wallet locks are acquired up front (sorted, to
        // avoid deadlock) because passing `tx` into wallet.credit makes it join
        // this transaction instead of taking its own internal per-user lock.
        const creditedUserIds = [...payoutMap.entries()]
          .filter(([, amount]) => amount > 0)
          .map(([userId]) => userId);
        await this.withWalletLocks(creditedUserIds, () =>
          this.repo.runInTransaction(async (tx) => {
            for (const p of participants) {
              const payout = payoutMap.get(p.userId) ?? 0;
              const isWinner = input.winners.includes(p.userId);
              let payoutTxnId: string | null = null;
              if (payout > 0) {
                const credit = await this.wallet.credit(
                  {
                    userId: p.userId,
                    currency: this.walletCurrency(fresh.currency),
                    amount: payout,
                    reason: WalletTxnReason.GAME_PAYOUT,
                    idempotencyKey: `game-payout:${fresh.id}:${p.userId}`,
                    referenceType: 'game_session',
                    referenceId: fresh.id,
                    metadata: { gameCode: fresh.code },
                    actorId: p.userId,
                  },
                  tx,
                );
                payoutTxnId = credit.transactionId;
                await this.repo.createTransaction(
                  {
                    sessionId: fresh.id,
                    participantId: p.id,
                    userId: p.userId,
                    type: GameTxnType.PAYOUT,
                    currency: fresh.currency,
                    amount: BigInt(payout),
                    walletTxnId: credit.transactionId,
                    idempotencyKey: `game-payout:${fresh.id}:${p.userId}`,
                  },
                  tx,
                );
              }
              await this.repo.updateParticipant(
                p.id,
                {
                  status: isWinner ? GameParticipantStatus.WON : GameParticipantStatus.LOST,
                  isWinner,
                  payoutAmount: BigInt(payout),
                  payoutTxnId,
                  settledAt: new Date(),
                },
                tx,
              );
            }

            await this.repo.createMatchResult(
              {
                sessionId: fresh.id,
                definitionId: fresh.definitionId,
                code: fresh.code,
                potAmount: fresh.potAmount,
                payoutTotal: BigInt(payoutTotal),
                rakeAmount: BigInt(rakeAmount),
                winners: input.winners,
                resultData: input.resultData ?? {},
                settledBy: input.settledBy ?? null,
              },
              tx,
            );
            await this.repo.completeSession(fresh.id, input.settledBy ?? null, tx);
          }),
        );

        await this.repo.logEvent({
          sessionId: fresh.id,
          action: 'session.settled',
          detail: { payoutTotal, rakeAmount, winners: input.winners },
        });

        // Leaderboards: wins + winnings by currency.
        for (const w of input.winners) await this.cache.addScore(GAME_WINS_LEADERBOARD_KEY, w, 1);
        for (const [userId, amount] of payoutMap) {
          if (amount > 0) {
            await this.cache.addScore(gameWinningsLeaderboardKey(fresh.currency), userId, amount);
          }
        }

        const payouts = [...payoutMap.entries()].map(([userId, amount]) => ({ userId, amount }));
        await this.bus.publish(
          new GameSettledEvent({
            sessionId: fresh.id,
            gameCode: fresh.code,
            roomId: fresh.roomId,
            currency: fresh.currency,
            potAmount: Number(fresh.potAmount),
            payoutTotal,
            rakeAmount,
            winners: input.winners,
            payouts,
            participants: participants.map((p) => p.userId),
          }),
        );
        await this.enqueueBestEffort(QUEUE_NAMES.ANALYTICS_PROCESSING, 'game.settled', {
          sessionId: fresh.id,
          gameCode: fresh.code,
          payoutTotal,
          rakeAmount,
        });
        await this.enqueueBestEffort(QUEUE_NAMES.RANKING_PROCESSING, 'game.settled', {
          sessionId: fresh.id,
          winners: input.winners,
        });

        return {
          sessionId: fresh.id,
          gameCode: fresh.code,
          potAmount: Number(fresh.potAmount),
          payoutTotal,
          rakeAmount,
          winners: input.winners,
          payouts,
        };
      },
      { ttlMs: 30_000 },
    );
  }

  /** Cancel-with-refund used by host cancel and the expiry monitor. */
  async abortSession(
    sessionId: string,
    status: GameSessionStatus,
    actorId: string | null,
    reason: string,
  ): Promise<{ refunded: string[] }> {
    return this.locks.withLock(gameSessionLockKey(sessionId), async () => {
      const fresh = await this.repo.getSession(sessionId);
      if (!fresh || fresh.status !== GameSessionStatus.ACTIVE) {
        throw this.conflict(ERROR_CODES.GAME_SESSION_NOT_ACTIVE, 'Session is not active.');
      }
      const participants = await this.repo.listParticipants(fresh.id);
      // Refund everyone whose stake is still unresolved: still PLAYING, or
      // LOST via an earlier mid-match forfeit that the match never settled
      // around (the forfeiter's stake would otherwise vanish — never paid to
      // a winner, since no winner was ever determined, and never refunded).
      const refundable = participants.filter(
        (p) =>
          p.stakeTxnId &&
          !p.payoutTxnId &&
          !p.refundTxnId &&
          (p.status === GameParticipantStatus.PLAYING || p.status === GameParticipantStatus.LOST),
      );
      const refunded = await this.refundParticipants(fresh, refundable);
      await this.repo.closeSession(fresh.id, status, actorId);
      await this.cache.del(gameLiveStateKey(fresh.id));
      await this.repo.logEvent({
        sessionId: fresh.id,
        userId: actorId,
        action: 'session.cancelled',
        detail: { status, reason, refunded: refunded.length },
      });
      await this.bus.publish(
        new GameCancelledEvent({
          sessionId: fresh.id,
          gameCode: fresh.code,
          roomId: fresh.roomId,
          status,
          refundedUserIds: refunded,
        }),
      );
      return { refunded };
    });
  }

  // ======================= In-session board relay =======================

  /**
   * Relay a board-game move to the other participants. The platform does NOT
   * validate game rules (peer-relay model preserved from the legacy backend) — it
   * authorises the sender, updates the live move log + turn pointer, and fans the
   * move out over the session room via the socket listener.
   */
  async relayMove(
    actor: GameActor,
    sessionId: string,
    moveData: Record<string, unknown>,
    onBehalfOf?: string,
  ): Promise<{ accepted: true; currentTurnUserId: string | null; isOver: boolean }> {
    // Generous but bounded — real gameplay (e.g. streaming `aim` previews
    // during a drag gesture) can be fairly chatty, but every call re-persists
    // the (growing) move log to Redis and fans out over sockets, so an
    // unbounded flood is real DoS/cost surface. ~20/sec sustained.
    await this.assertRateLimit(actor.id, 'move', 1200, 60);
    const session = await this.repo.getSession(sessionId);
    if (!session) throw this.notFound(ERROR_CODES.GAME_SESSION_NOT_FOUND, 'Session not found.');
    if (session.status !== GameSessionStatus.ACTIVE) {
      throw this.conflict(ERROR_CODES.GAME_SESSION_NOT_ACTIVE, 'Session is not active.');
    }

    // A bot has no client — the host drives its turn via onBehalfOf. Otherwise the
    // sender must be an active participant relaying their own move.
    let moverId = actor.id;
    if (onBehalfOf && onBehalfOf !== actor.id) {
      if (session.hostId !== actor.id) {
        throw new BusinessException(
          ERROR_CODES.GAME_NOT_HOST,
          'Only the host may relay a move for a bot.',
          HttpStatus.FORBIDDEN,
        );
      }
      const bot = await this.repo.getParticipant(sessionId, onBehalfOf);
      if (!bot || !bot.isBot || bot.status !== GameParticipantStatus.PLAYING) {
        throw new BusinessException(
          ERROR_CODES.GAME_NOT_PARTICIPANT,
          'That seat is not an active bot in this session.',
          HttpStatus.FORBIDDEN,
        );
      }
      moverId = onBehalfOf;
    } else {
      const participant = await this.repo.getParticipant(sessionId, actor.id);
      if (!participant || participant.status !== GameParticipantStatus.PLAYING) {
        throw new BusinessException(
          ERROR_CODES.GAME_NOT_PARTICIPANT,
          'You are not an active participant of this session.',
          HttpStatus.FORBIDDEN,
        );
      }
    }

    const frame = { playerId: moverId, moveData, timestamp: Date.now() };
    const state = await this.locks.withLock(gameSessionLockKey(sessionId), async () => {
      const current = await this.loadOrInitLiveState(session);
      if (current.isOver) {
        throw new BusinessException(
          ERROR_CODES.GAME_ALREADY_OVER,
          'This match has already ended.',
          HttpStatus.CONFLICT,
        );
      }
      // Enforce turn ownership under the same lock we mutate state in — this
      // is the primary defense against turn hijacking (see canAct's doc):
      // being an active PLAYING participant (checked above) is NOT enough,
      // the mover must actually hold the current turn (sync_state excepted).
      if (!canAct(current, frame)) {
        throw new BusinessException(
          ERROR_CODES.GAME_NOT_YOUR_TURN,
          "It isn't your turn.",
          HttpStatus.FORBIDDEN,
        );
      }
      const next = applyMove(current, frame);
      await this.cache.set(gameLiveStateKey(sessionId), next, GAME_LIVE_STATE_TTL_SECONDS);
      return next;
    });

    await this.bus.publish(
      new GameMoveEvent({
        sessionId,
        roomId: session.roomId,
        playerId: moverId,
        moveData,
        timestamp: frame.timestamp,
        currentTurnUserId: state.currentTurnUserId,
        rev: state.rev ?? 0,
      }),
    );
    return { accepted: true, currentTurnUserId: state.currentTurnUserId, isOver: state.isOver };
  }

  /**
   * Host-reported match result for a board game. Peer-relay games are not
   * server-validated, so the host reports the winner(s); the platform derives the
   * payout from the escrowed pot (never a client-sent amount) — the winner takes
   * the pot minus house rake, or a winning team splits it.
   *
   * The host is NOT a trusted role (in matchmaking it's just whichever player
   * happened to be first-queued), so their report alone is never enough to pay
   * out: it's held as a PendingMatchResult until another active participant
   * corroborates it via `confirmMatchResult` (or the confirm window elapses
   * with nobody disputing — see `sweepPendingResults`). Any other active
   * participant may instead `disputeMatchResult` to withhold settlement for
   * admin review. If nobody else is left to corroborate (shouldn't normally
   * happen — forfeit() already auto-settles a sole survivor), it settles
   * immediately since there's no one left to wait on.
   */
  async reportMatchResult(
    actor: GameActor,
    sessionId: string,
    input: { winners?: string[]; winningTeam?: GameTeam; resultData?: Record<string, unknown> },
  ): Promise<unknown> {
    await this.assertRateLimit(actor.id, 'report-result', 5, 60);
    const session = await this.repo.getSession(sessionId);
    if (!session) throw this.notFound(ERROR_CODES.GAME_SESSION_NOT_FOUND, 'Session not found.');
    if (session.hostId !== actor.id) {
      throw new BusinessException(
        ERROR_CODES.GAME_NOT_HOST,
        'Only the session host can report the match result.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (session.status !== GameSessionStatus.ACTIVE) {
      throw this.conflict(ERROR_CODES.GAME_SESSION_NOT_ACTIVE, 'Session is not active.');
    }

    // 2v2: the host reports the winning TEAM; the platform expands it to both
    // teammates so a lopsided/incomplete team report is impossible. CLASSIC keeps
    // the explicit winner list. Either way the pot is split via the single path.
    let winners: string[];
    if (session.mode === GameMode.TEAM_2V2) {
      if (!input.winningTeam) {
        throw new BusinessException(
          ERROR_CODES.GAME_INVALID_PAYOUT,
          'A 2v2 result must name the winning team.',
          HttpStatus.BAD_REQUEST,
        );
      }
      const participants = await this.repo.listParticipants(sessionId);
      winners = expandTeamWinners(participants, input.winningTeam);
    } else {
      winners = input.winners ?? [];
    }
    if (winners.length === 0) {
      throw new BusinessException(
        ERROR_CODES.GAME_INVALID_PAYOUT,
        'At least one winner is required to settle a match.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const resultData = input.resultData ?? {};

    return this.locks.withLock(gameSessionLockKey(sessionId), async () => {
      const fresh = await this.repo.getSession(sessionId);
      if (!fresh || fresh.status !== GameSessionStatus.ACTIVE) {
        throw this.conflict(ERROR_CODES.GAME_SESSION_NOT_ACTIVE, 'Session is not active.');
      }
      if (await this.cache.get(gamePendingResultKey(sessionId))) {
        throw this.conflict(
          ERROR_CODES.GAME_RESULT_ALREADY_REPORTED,
          'A result has already been reported for this session and is awaiting confirmation.',
        );
      }

      const participants = await this.repo.listParticipants(sessionId);
      const otherActive = participants.filter(
        (p) => p.status === GameParticipantStatus.PLAYING && p.userId !== actor.id && !p.isBot,
      );
      if (otherActive.length === 0) {
        return this.settleToHumanWinners(session, winners, resultData, actor.id);
      }

      const expiresAt = Date.now() + GAME_RESULT_CONFIRM_SECONDS * 1000;
      const pending: PendingMatchResult = {
        winners,
        resultData,
        reportedBy: actor.id,
        reportedAt: Date.now(),
        expiresAt,
      };
      await this.cache.set(
        gamePendingResultKey(sessionId),
        pending,
        GAME_RESULT_CONFIRM_SECONDS + 60,
      );
      await this.cache.setScore(GAME_PENDING_RESULT_INDEX_KEY, sessionId, expiresAt);
      await this.repo.logEvent({
        sessionId,
        userId: actor.id,
        action: 'session.result_reported',
        detail: { winners, expiresAt },
      });
      await this.bus.publish(
        new GameResultReportedEvent({
          sessionId,
          roomId: session.roomId,
          reportedBy: actor.id,
          winners,
          expiresAt,
        }),
      );
      return { status: 'pending_confirmation', winners, expiresAt };
    });
  }

  /**
   * Corroborate a host-reported result from a DIFFERENT active participant —
   * required before the platform will actually pay out. See reportMatchResult.
   */
  async confirmMatchResult(actor: GameActor, sessionId: string): Promise<unknown> {
    const session = await this.repo.getSession(sessionId);
    if (!session) throw this.notFound(ERROR_CODES.GAME_SESSION_NOT_FOUND, 'Session not found.');

    const outcome = await this.locks.withLock(gameSessionLockKey(sessionId), async () => {
      const fresh = await this.repo.getSession(sessionId);
      if (!fresh || fresh.status !== GameSessionStatus.ACTIVE) {
        throw this.conflict(ERROR_CODES.GAME_SESSION_NOT_ACTIVE, 'Session is not active.');
      }
      const participant = await this.repo.getParticipant(sessionId, actor.id);
      if (!participant || participant.status !== GameParticipantStatus.PLAYING) {
        throw new BusinessException(
          ERROR_CODES.GAME_NOT_PARTICIPANT,
          'You are not an active participant of this session.',
          HttpStatus.FORBIDDEN,
        );
      }
      const pending = await this.cache.get<PendingMatchResult>(gamePendingResultKey(sessionId));
      if (!pending) {
        throw this.conflict(
          ERROR_CODES.GAME_RESULT_PENDING_CONFIRMATION,
          'There is no reported result awaiting confirmation for this session.',
        );
      }
      if (pending.reportedBy === actor.id) {
        throw new BusinessException(
          ERROR_CODES.GAME_NOT_AUTHORIZED,
          'The result must be confirmed by a different participant than the one who reported it.',
          HttpStatus.FORBIDDEN,
        );
      }
      await this.cache.del(gamePendingResultKey(sessionId));
      await this.cache.sortedRemove(GAME_PENDING_RESULT_INDEX_KEY, sessionId);
      return pending;
    });

    return this.settleToHumanWinners(
      session,
      outcome.winners,
      outcome.resultData,
      outcome.reportedBy,
    );
  }

  /**
   * A non-reporting active participant disputes a pending result — settlement
   * is withheld (the session stays ACTIVE) pending admin review via the
   * trusted `settleResult` seam. See reportMatchResult.
   */
  async disputeMatchResult(actor: GameActor, sessionId: string): Promise<{ disputed: true }> {
    const session = await this.repo.getSession(sessionId);
    if (!session) throw this.notFound(ERROR_CODES.GAME_SESSION_NOT_FOUND, 'Session not found.');

    return this.locks.withLock(gameSessionLockKey(sessionId), async () => {
      const fresh = await this.repo.getSession(sessionId);
      if (!fresh || fresh.status !== GameSessionStatus.ACTIVE) {
        throw this.conflict(ERROR_CODES.GAME_SESSION_NOT_ACTIVE, 'Session is not active.');
      }
      const participant = await this.repo.getParticipant(sessionId, actor.id);
      if (!participant || participant.status !== GameParticipantStatus.PLAYING) {
        throw new BusinessException(
          ERROR_CODES.GAME_NOT_PARTICIPANT,
          'You are not an active participant of this session.',
          HttpStatus.FORBIDDEN,
        );
      }
      const pending = await this.cache.get<PendingMatchResult>(gamePendingResultKey(sessionId));
      if (!pending) {
        throw this.conflict(
          ERROR_CODES.GAME_RESULT_PENDING_CONFIRMATION,
          'There is no reported result awaiting confirmation for this session.',
        );
      }
      if (pending.reportedBy === actor.id) {
        throw new BusinessException(
          ERROR_CODES.GAME_NOT_AUTHORIZED,
          'You cannot dispute your own reported result.',
          HttpStatus.FORBIDDEN,
        );
      }
      await this.cache.del(gamePendingResultKey(sessionId));
      await this.cache.sortedRemove(GAME_PENDING_RESULT_INDEX_KEY, sessionId);
      await this.repo.logEvent({
        sessionId,
        userId: actor.id,
        action: 'session.result_disputed',
        detail: { reportedBy: pending.reportedBy, winners: pending.winners },
      });
      await this.bus.publish(
        new GameResultDisputedEvent({
          sessionId,
          roomId: fresh.roomId,
          disputedBy: actor.id,
          reportedBy: pending.reportedBy,
        }),
      );
      return { disputed: true as const };
    });
  }

  /**
   * Auto-settles a reported result nobody disputed within the confirm window
   * — otherwise a legitimately-won match could hang forever waiting on an
   * opponent who disconnected, or who simply won't confirm a loss.
   */
  async sweepPendingResults(now: Date): Promise<void> {
    const due = await this.cache.sortedRangeByScore(
      GAME_PENDING_RESULT_INDEX_KEY,
      0,
      now.getTime(),
    );
    for (const sessionId of due) {
      try {
        const outcome = await this.locks.withLock(gameSessionLockKey(sessionId), async () => {
          const pending = await this.cache.get<PendingMatchResult>(gamePendingResultKey(sessionId));
          await this.cache.sortedRemove(GAME_PENDING_RESULT_INDEX_KEY, sessionId);
          if (!pending || pending.expiresAt > Date.now()) return null;
          const session = await this.repo.getSession(sessionId);
          if (!session || session.status !== GameSessionStatus.ACTIVE) {
            await this.cache.del(gamePendingResultKey(sessionId));
            return null;
          }
          await this.cache.del(gamePendingResultKey(sessionId));
          return { session, pending };
        });
        if (!outcome) continue;
        await this.repo.logEvent({
          sessionId,
          action: 'session.result_auto_confirmed',
          detail: { reportedBy: outcome.pending.reportedBy, winners: outcome.pending.winners },
        });
        await this.settleToHumanWinners(
          outcome.session,
          outcome.pending.winners,
          outcome.pending.resultData,
          outcome.pending.reportedBy,
        );
      } catch (err) {
        this.logger.warn(
          `Failed to auto-confirm pending result for session ${sessionId}: ${(err as Error).message}`,
        );
      }
    }
  }

  /** Live board state for a reconnecting client (move log + turn + remaining seconds). */
  async getLiveState(actor: GameActor, sessionId: string): Promise<unknown> {
    const session = await this.repo.getSession(sessionId);
    if (!session) throw this.notFound(ERROR_CODES.GAME_SESSION_NOT_FOUND, 'Session not found.');
    await this.assertSessionViewable(actor, sessionId);
    const state = await this.loadOrInitLiveState(session);
    const elapsed = Math.floor((Date.now() - state.turnStartedAt) / 1000);
    return {
      sessionId,
      // The ordering token for this snapshot. A client that has already
      // applied live moves past this revision must DISCARD the snapshot
      // rather than replay it — see `GameLiveState.rev`.
      rev: state.rev ?? 0,
      currentTurnUserId: state.currentTurnUserId,
      // The seats still in rotation. A forfeit removes a seat via `removeSeat`
      // without appending a move frame, so a client restoring purely from
      // `moves` would otherwise put a departed player back on the board.
      seatOrder: state.seatOrder,
      turnRemainingSeconds: Math.max(0, state.turnSeconds - elapsed),
      isOver: state.isOver,
      moves: state.moves,
    };
  }

  /**
   * A participant forfeits/leaves an active match. Unlike a game outcome (which
   * the platform never derives), a forfeit is deterministic — the leaver forfeits
   * their claim — so the platform resolves it directly: if exactly one PLAYING
   * participant remains they take the pot (escrow-bounded via settleResult); if
   * NONE remain, the platform has no refund policy once a match has started — the
   * actor calling this (the very last participant to leave) is awarded the full
   * pot instead; if 2+ remain the match continues without the forfeiter (clients
   * withdraw the seat). Always relays a forfeit event so in-progress boards
   * withdraw the seat.
   *
   * The "who else is still PLAYING" read and the resulting write (mark this
   * seat LOST when the match continues) run under the session lock so two
   * near-simultaneous forfeits can't both observe the same stale "2+ remain"
   * snapshot and both take the continue branch — which would strand the
   * actual sole survivor in a match that never settles. settleResult/
   * settleToHumanWinners take this same lock key themselves, so the actual
   * settlement call happens AFTER the lock is released (the lock isn't
   * reentrant — calling it again while held would deadlock).
   */
  async forfeit(actor: GameActor, sessionId: string): Promise<unknown> {
    const session = await this.repo.getSession(sessionId);
    if (!session) throw this.notFound(ERROR_CODES.GAME_SESSION_NOT_FOUND, 'Session not found.');
    if (session.status !== GameSessionStatus.ACTIVE) {
      throw this.conflict(ERROR_CODES.GAME_SESSION_NOT_ACTIVE, 'Session is not active.');
    }

    const decision = await this.locks.withLock(gameSessionLockKey(sessionId), async () => {
      const participant = await this.repo.getParticipant(sessionId, actor.id);
      if (!participant || participant.status !== GameParticipantStatus.PLAYING) {
        throw new BusinessException(
          ERROR_CODES.GAME_NOT_PARTICIPANT,
          'You are not an active participant of this session.',
          HttpStatus.FORBIDDEN,
        );
      }
      const participants = await this.repo.listParticipants(sessionId);
      const seat = participants.findIndex((p) => p.userId === actor.id);
      const remaining = participants.filter(
        (p) => p.status === GameParticipantStatus.PLAYING && p.userId !== actor.id,
      );

      // TEAM_2V2 forfeits are team-aware: the match ends only when a whole
      // team is out, and the surviving team's still-PLAYING members split
      // the pot.
      const result =
        session.mode === GameMode.TEAM_2V2
          ? await this.decideTeamForfeit(participant, actor.id, remaining, seat)
          : await this.decideForfeit(participant, actor.id, remaining, seat);

      // Match continues without the forfeiter: drop their seat from the live
      // turn rotation now (and hand off the turn if it was theirs) so future
      // laps don't keep stalling on a seat that can never move again.
      if (result.kind === 'continue') {
        const state = await this.loadOrInitLiveState(session);
        const updated = removeSeat(state, actor.id, Date.now());
        await this.cache.set(gameLiveStateKey(sessionId), updated, GAME_LIVE_STATE_TTL_SECONDS);
      }
      // The host is the client that drives every bot seat, so a match that
      // continues WITHOUT its host is a match whose bots have stopped. Hand
      // the role to someone still at the table before releasing the lock.
      if (result.kind === 'continue' && session.hostId === actor.id) {
        result.newHostId = this.pickSessionHost(participants, { exclude: actor.id });
      }
      return result;
    });

    await this.repo.logEvent({
      sessionId,
      userId: actor.id,
      action: 'session.forfeit',
      detail: { seat: decision.seat, remaining: decision.remainingCount },
    });
    await this.bus.publish(
      new GameForfeitEvent({
        sessionId,
        gameCode: session.code,
        roomId: session.roomId,
        userId: actor.id,
        seat: decision.seat,
      }),
    );

    if (decision.kind === 'settle') {
      return this.settleToHumanWinners(session, decision.winners, decision.resultData, actor.id);
    }
    // Published outside the lock, like every other event here — the seat is
    // already out of rotation, so the new host can start driving the moment
    // this lands.
    if (decision.newHostId) {
      await this.handOverHost(session, decision.newHostId, 'host_forfeited');
    }
    return { forfeitedBy: actor.id, remaining: decision.remainingCount };
  }

  /**
   * Decide (and, for the non-settling branch, persist) the outcome of a
   * CLASSIC-mode forfeit. Must be called with the session lock held — see
   * `forfeit()`. `remaining` are the still-PLAYING participants other than
   * the forfeiter.
   */
  private async decideForfeit(
    participant: GameParticipant,
    actorId: string,
    remaining: GameParticipant[],
    seat: number,
  ): Promise<ForfeitDecision> {
    if (remaining.length === 0) {
      // Everyone else already left — no refunds once a match has started, so
      // the LAST participant to leave (the one calling this, by construction —
      // every other PLAYING seat already forfeited before them) takes the pot
      // instead of it being returned to nobody in particular.
      return {
        kind: 'settle',
        winners: [actorId],
        resultData: { reason: 'forfeit_last_to_leave', forfeitedBy: actorId },
        seat,
        remainingCount: 0,
      };
    }
    if (remaining.length === 1) {
      // Sole survivor takes the pot (minus house rake). Deterministic → the
      // platform settles it directly; settleResult still caps payout at the pot.
      return {
        kind: 'settle',
        winners: [remaining[0].userId],
        resultData: { reason: 'forfeit', forfeitedBy: actorId },
        seat,
        remainingCount: 1,
      };
    }
    // Only bots left. `remaining` counts them as players, so this used to
    // "continue" a match with nobody at the table: no client drives a bot
    // (that is the host's job, and the host just left), nobody can report a
    // winner, and it sat there until the 15-minute stale-session sweep — the
    // frozen board everyone still in the room was looking at. A match with no
    // humans in it is over. `settleToHumanWinners` already knows what to do
    // with an all-bot winner set: refund a staked pot, settle a friendly one.
    if (remaining.every((p) => p.isBot)) {
      return {
        kind: 'settle',
        winners: remaining.map((p) => p.userId),
        resultData: { reason: 'forfeit_no_humans_left', forfeitedBy: actorId },
        seat,
        remainingCount: remaining.length,
      };
    }
    // 2+ remain — the match continues without the forfeiter; mark them out so
    // they can no longer relay moves, and let the winner be reported normally.
    await this.repo.updateParticipant(participant.id, {
      status: GameParticipantStatus.LOST,
      settledAt: new Date(),
    });
    return { kind: 'continue', seat, remainingCount: remaining.length };
  }

  /**
   * Decide (and, for the non-settling branch, persist) the outcome of a
   * TEAM_2V2 forfeit. Must be called with the session lock held — see
   * `forfeit()`. If no team retains a player, no refunds once a match has
   * started — the actor (the last of all four seats still PLAYING, by
   * construction, since every other seat already forfeited) takes the pot
   * alone; if exactly one team retains players it wins (its survivors split
   * the pot — a forfeiter forfeits their claim, so a lone survivor takes the
   * team's whole share); if both teams retain players the match continues.
   */
  private async decideTeamForfeit(
    participant: GameParticipant,
    actorId: string,
    remaining: GameParticipant[],
    seat: number,
  ): Promise<ForfeitDecision> {
    const teamsLeft = new Set(remaining.map((p) => p.team));
    if (teamsLeft.size === 0) {
      return {
        kind: 'settle',
        winners: [actorId],
        resultData: { reason: 'forfeit_last_to_leave', forfeitedBy: actorId },
        seat,
        remainingCount: 0,
      };
    }
    if (teamsLeft.size === 1) {
      return {
        kind: 'settle',
        winners: remaining.map((p) => p.userId),
        resultData: { reason: 'forfeit', forfeitedBy: actorId },
        seat,
        remainingCount: remaining.length,
      };
    }
    // Same rule as the CLASSIC path: a table with no humans left on it has
    // nobody to drive the bots or report a winner, so the match is over rather
    // than left running against itself.
    if (remaining.every((p) => p.isBot)) {
      return {
        kind: 'settle',
        winners: remaining.map((p) => p.userId),
        resultData: { reason: 'forfeit_no_humans_left', forfeitedBy: actorId },
        seat,
        remainingCount: remaining.length,
      };
    }
    // Both teams still have players — continue without the forfeiter.
    await this.repo.updateParticipant(participant.id, {
      status: GameParticipantStatus.LOST,
      settledAt: new Date(),
    });
    return { kind: 'continue', seat, remainingCount: remaining.length };
  }

  /**
   * Split the escrowed pot (minus house rake) across the HUMAN winners and settle.
   * Bots hold no wallet, so a bot's share collapses into its human co-winners; if
   * every winner is a bot, no human can collect and the human stakers are refunded.
   */
  private async settleToHumanWinners(
    session: GameSession,
    winners: string[],
    resultData: Record<string, unknown>,
    actorId: string,
  ): Promise<unknown> {
    const participants = await this.repo.listParticipants(session.id);
    const botIds = new Set(participants.filter((p) => p.isBot).map((p) => p.userId));
    const humanWinners = winners.filter((w) => !botIds.has(w));
    if (humanWinners.length === 0) {
      if (Number(session.stake) > 0) {
        return this.abortSession(
          session.id,
          GameSessionStatus.CANCELLED,
          actorId,
          'bot_won_refund',
        );
      }
      // Settle friendly matches normally when only bots win
      return this.settleResult({
        sessionId: session.id,
        winners,
        payouts: [],
        resultData,
        settledBy: actorId,
      });
    }
    const def = await this.repo.getDefinitionByCode(session.code);
    const rakeBps = def?.houseRakeBps ?? 0;
    const pot = Number(session.potAmount);
    const distributable = pot - Math.floor((pot * rakeBps) / 10_000);
    return this.settleResult({
      sessionId: session.id,
      winners: humanWinners,
      payouts: this.splitPot(distributable, humanWinners),
      resultData,
      settledBy: actorId,
    });
  }

  /**
   * Presence-driven auto-forfeit: when a player fully disconnects (their last
   * socket across all namespaces drops), forfeit their active match. A no-op if
   * they aren't currently playing; forfeit errors are swallowed (best-effort).
   */
  async forfeitOnDisconnect(userId: string): Promise<void> {
    const sessionId = await this.repo.findActiveSessionForParticipant(userId);
    if (!sessionId) return;
    try {
      await this.forfeit({ id: userId, roles: [] }, sessionId);
    } catch (err) {
      this.logger.warn(
        `Auto-forfeit for ${userId} in session ${sessionId} failed: ${(err as Error).message}`,
      );
    }
  }

  // ======================= Matchmaking =======================

  /**
   * Join a matchmaking bucket (game + stake + matchType). Under the bucket lock,
   * add the player and — if the bucket now holds the required count — pop the
   * earliest players and open a ready-check. Redis-ephemeral: no money moves until
   * every matched player accepts and `startSessionFromLobby` runs.
   */
  async joinQueue(
    actor: GameActor,
    input: { gameCode: GameCode; stake: number; matchType: MatchType },
  ): Promise<{ status: 'QUEUED' | 'MATCHED'; matchType: MatchType; matchId?: string }> {
    await this.assertRateLimit(actor.id, 'queue', 10, 60);
    if (!matchmakingEnabled()) {
      throw this.conflict(
        ERROR_CODES.GAME_MATCHMAKING_DISABLED,
        'Matchmaking is temporarily unavailable.',
      );
    }
    const def = await this.requireEnabledDefinition(input.gameCode);
    this.assertStakeInRange(def, input.stake);
    if (input.matchType === 'TEAM_2V2') this.assert2v2Supported(input.gameCode);
    await this.assertCanAfford(actor.id, def.currency, BigInt(input.stake));

    if (await this.cache.get(gameMatchReadyUserKey(actor.id))) {
      throw this.conflict(ERROR_CODES.GAME_ALREADY_QUEUED, 'You already have a pending match.');
    }
    if (await this.cache.get<MatchQueuePointer>(gameMatchUserKey(actor.id))) {
      throw this.conflict(ERROR_CODES.GAME_ALREADY_QUEUED, 'You are already in the queue.');
    }

    const bucketKey = gameMatchQueueKey(input.gameCode, input.stake, input.matchType);
    const ttl = matchQueueTtlSeconds() + 30;
    return this.locks.withLock(gameMatchBucketLockKey(bucketKey), async () => {
      const now = Date.now();
      await this.cache.setScore(bucketKey, actor.id, now);
      await this.cache.set(
        gameMatchUserKey(actor.id),
        { bucketKey, retries: 0, firstQueuedAt: now } satisfies MatchQueuePointer,
        ttl,
      );
      await this.cache.setAdd(GAME_MATCH_BUCKET_INDEX_KEY, bucketKey);

      const need = requiredSize(input.matchType);
      if ((await this.cache.sortedCount(bucketKey)) >= need) {
        const lowest = await this.cache.sortedLowest(bucketKey, need);
        const playerIds = lowest.map((e) => e.member);
        const retriesByUser: Record<string, number> = {};
        for (const id of playerIds) {
          const ptr = await this.cache.get<MatchQueuePointer>(gameMatchUserKey(id));
          retriesByUser[id] = ptr?.retries ?? 0;
        }
        await this.cache.sortedRemove(bucketKey, ...playerIds);
        for (const id of playerIds) await this.cache.del(gameMatchUserKey(id));
        const matchId = await this.openReadyCheck(def, input, bucketKey, playerIds, retriesByUser);
        void this.enqueueMmTelemetry('matchmaking.matched', {
          gameCode: def.code,
          stake: input.stake,
          matchType: input.matchType,
          bucketDepth: need,
          waitedMs: lowest.map((e) => now - e.score),
        });
        if (playerIds.includes(actor.id)) {
          return { status: 'MATCHED', matchType: input.matchType, matchId };
        }
      }
      void this.enqueueMmTelemetry('matchmaking.queued', {
        gameCode: def.code,
        stake: input.stake,
        matchType: input.matchType,
      });
      return { status: 'QUEUED', matchType: input.matchType };
    });
  }

  /** Persist a ready-check + index it + notify each matched player. Freezes hostId. */
  private async openReadyCheck(
    def: GameDefinition,
    input: { gameCode: GameCode; stake: number; matchType: MatchType },
    bucketKey: string,
    playerIds: string[],
    retriesByUser: Record<string, number>,
  ): Promise<string> {
    const matchId = this.generatePublicId();
    const now = Date.now();
    const readySeconds = matchReadySeconds();
    const expiresAt = now + readySeconds * 1000;
    const state: ReadyCheckState = {
      matchId,
      v: MATCHMAKING_PROTOCOL_VERSION,
      gameCode: input.gameCode,
      stake: input.stake,
      matchType: input.matchType,
      currency: def.currency,
      mode: matchModeFor(input.matchType),
      bucketKey,
      players: playerIds,
      ready: [],
      hostId: playerIds[0],
      retriesByUser,
      expiresAt,
      createdAt: now,
    };
    const ttl = readySeconds + 30;
    await this.cache.set(gameMatchReadyKey(matchId), state, ttl);
    await this.cache.setScore(GAME_MATCH_READY_INDEX_KEY, matchId, expiresAt);
    for (const id of playerIds) await this.cache.set(gameMatchReadyUserKey(id), matchId, ttl);
    await this.bus.publish(
      new GameMatchFoundEvent({
        v: MATCHMAKING_PROTOCOL_VERSION,
        matchId,
        gameCode: input.gameCode,
        stake: input.stake,
        matchType: input.matchType,
        players: playerIds,
        readySeconds,
        expiresAt,
      }),
    );
    return matchId;
  }

  /** A matched player readies up. When all are ready, finalize into a real session. */
  async acceptMatch(actor: GameActor, matchId: string): Promise<unknown> {
    await this.assertRateLimit(actor.id, 'accept', 20, 60);
    return this.locks.withLock(gameMatchReadyLockKey(matchId), async () => {
      const state = await this.cache.get<ReadyCheckState>(gameMatchReadyKey(matchId));
      if (!state || !state.players.includes(actor.id)) {
        throw this.notFound(ERROR_CODES.GAME_MATCH_NOT_FOUND, 'Match not found.');
      }
      if (Date.now() > state.expiresAt) {
        throw this.conflict(ERROR_CODES.GAME_MATCH_EXPIRED, 'This match has expired.');
      }
      if (!state.ready.includes(actor.id)) state.ready.push(actor.id);

      if (state.ready.length >= state.players.length) {
        const session = await this.finalizeMatch(state);
        return { status: 'STARTED', session };
      }
      const ttl = Math.max(1, Math.ceil((state.expiresAt - Date.now()) / 1000));
      await this.cache.set(gameMatchReadyKey(matchId), state, ttl);
      const remaining = state.players.filter((p) => !state.ready.includes(p));
      await this.bus.publish(
        new GameMatchReadyProgressEvent({
          v: MATCHMAKING_PROTOCOL_VERSION,
          matchId,
          players: state.players,
          ready: state.ready,
          remaining,
        }),
      );
      return { status: 'WAITING', ready: state.ready.length, total: state.players.length };
    });
  }

  /**
   * Turn a fully-ready match into a real lobby + session. Creates the matchmade
   * lobby with all players (host = first-queued), then delegates to the single
   * `startSessionFromLobby` seam for escrow + start. If escrow aborts, the
   * transient lobby is closed and the players are told (no parallel start path).
   */
  private async finalizeMatch(state: ReadyCheckState): Promise<unknown> {
    const def = await this.requireEnabledDefinition(state.gameCode);
    const carrom = this.enforceCarromSettings(
      state.mode,
      state.mode === GameMode.TEAM_2V2 ? 'classic' : undefined,
      state.mode === GameMode.TEAM_2V2 ? 'team_a_white' : undefined,
    );
    const code = await this.generateJoinCode();
    const lobby = await this.repo.createLobby({
      definitionId: def.id,
      code,
      hostId: state.hostId,
      roomId: null,
      category: def.category,
      currency: def.currency,
      stake: BigInt(state.stake),
      maxPlayers: effectiveMaxPlayers(def.code, state.mode, def.maxPlayers),
      mode: state.mode,
      carromMode: carrom.carromMode,
      teamCoinAssignment: carrom.teamCoinAssignment,
      isMatchmade: true,
      status: GameLobbyStatus.OPEN,
      expiresAt: new Date(Date.now() + GAME_LOBBY_TTL_MS),
      createdBy: state.hostId,
    });
    for (const id of state.players) await this.repo.addMember(lobby.id, id);
    await this.clearReadyCheck(state);
    void this.enqueueMmTelemetry('matchmaking.ready_result', {
      matchType: state.matchType,
      result: 'all_ready',
      elapsedMs: Date.now() - state.createdAt,
    });
    try {
      return await this.startSessionFromLobby(lobby.id, state.hostId);
    } catch (err) {
      await this.repo.markLobbyClosed(lobby.id, GameLobbyStatus.CANCELLED, state.hostId);
      await this.bus.publish(
        new GameMatchCancelledEvent({
          v: MATCHMAKING_PROTOCOL_VERSION,
          matchId: state.matchId,
          reason: 'stake_failed',
          players: state.players,
          requeued: [],
        }),
      );
      throw err;
    }
  }

  /** Explicit decline — dissolves the ready-check immediately (decliner dropped). */
  async declineMatch(actor: GameActor, matchId: string): Promise<{ declined: boolean }> {
    await this.assertRateLimit(actor.id, 'decline', 20, 60);
    await this.locks.withLock(gameMatchReadyLockKey(matchId), async () => {
      const state = await this.cache.get<ReadyCheckState>(gameMatchReadyKey(matchId));
      if (!state || !state.players.includes(actor.id)) {
        throw this.notFound(ERROR_CODES.GAME_MATCH_NOT_FOUND, 'Match not found.');
      }
      await this.dissolveReadyCheck(state, 'declined', actor.id);
    });
    return { declined: true };
  }

  /**
   * Dissolve a ready-check: re-queue the consenting (ready, non-decliner) players
   * up to the retry cap, drop the rest, clear all state, and fan out a cancel.
   */
  private async dissolveReadyCheck(
    state: ReadyCheckState,
    reason: MatchCancelReason,
    declinerId?: string,
  ): Promise<void> {
    const maxRetries = matchMaxRetries();
    const ttl = matchQueueTtlSeconds() + 30;
    const now = Date.now();
    const requeued: string[] = [];
    for (const playerId of state.players) {
      const consented = state.ready.includes(playerId) && playerId !== declinerId;
      const nextRetries = (state.retriesByUser[playerId] ?? 0) + 1;
      if (consented && nextRetries <= maxRetries) {
        await this.cache.setScore(state.bucketKey, playerId, now);
        await this.cache.set(
          gameMatchUserKey(playerId),
          { bucketKey: state.bucketKey, retries: nextRetries, firstQueuedAt: now },
          ttl,
        );
        await this.cache.setAdd(GAME_MATCH_BUCKET_INDEX_KEY, state.bucketKey);
        requeued.push(playerId);
        await this.repo.logEvent({
          userId: playerId,
          action: 'matchmaking.queue_exit',
          detail: { reason, retries: nextRetries, requeued: true },
        });
      } else {
        const exit = consented ? 'exhausted' : playerId === declinerId ? 'declined' : 'dropped';
        await this.repo.logEvent({
          userId: playerId,
          action: 'matchmaking.queue_exit',
          detail: { reason: exit },
        });
      }
    }
    await this.clearReadyCheck(state);
    await this.bus.publish(
      new GameMatchCancelledEvent({
        v: MATCHMAKING_PROTOCOL_VERSION,
        matchId: state.matchId,
        reason,
        players: state.players,
        requeued,
      }),
    );
    void this.enqueueMmTelemetry('matchmaking.ready_result', {
      matchType: state.matchType,
      result: reason,
      acceptedCount: state.ready.length,
      declinedCount: state.players.length - state.ready.length,
      elapsedMs: Date.now() - state.createdAt,
    });
  }

  /** Delete a ready-check's Redis footprint (state blob, index entry, user pointers). */
  private async clearReadyCheck(state: ReadyCheckState): Promise<void> {
    await this.cache.del(gameMatchReadyKey(state.matchId));
    await this.cache.sortedRemove(GAME_MATCH_READY_INDEX_KEY, state.matchId);
    for (const id of state.players) await this.cache.del(gameMatchReadyUserKey(id));
  }

  /** Current matchmaking state for a (reconnecting) user: READY_CHECK | QUEUED | IDLE. */
  async getMatchmakingStatus(actor: GameActor): Promise<unknown> {
    const matchId = await this.cache.get<string>(gameMatchReadyUserKey(actor.id));
    if (matchId) {
      const state = await this.cache.get<ReadyCheckState>(gameMatchReadyKey(matchId));
      if (state) {
        return {
          state: 'READY_CHECK',
          matchId,
          players: state.players,
          ready: state.ready,
          expiresAt: state.expiresAt,
        };
      }
    }
    const ptr = await this.cache.get<MatchQueuePointer>(gameMatchUserKey(actor.id));
    if (ptr) {
      const position = await this.cache.sortedRank(ptr.bucketKey, actor.id);
      return { state: 'QUEUED', bucketKey: ptr.bucketKey, position, retries: ptr.retries };
    }
    return { state: 'IDLE' };
  }

  /** Leave the queue (idempotent). Records the exit reason + waited time for analytics. */
  async leaveQueue(actor: GameActor, reason = 'left'): Promise<{ left: boolean }> {
    await this.assertRateLimit(actor.id, 'leave', 20, 60);
    const ptr = await this.cache.get<MatchQueuePointer>(gameMatchUserKey(actor.id));
    if (!ptr) return { left: false };
    await this.locks.withLock(gameMatchBucketLockKey(ptr.bucketKey), async () => {
      await this.cache.sortedRemove(ptr.bucketKey, actor.id);
      await this.cache.del(gameMatchUserKey(actor.id));
      if ((await this.cache.sortedCount(ptr.bucketKey)) === 0) {
        await this.cache.setRemove(GAME_MATCH_BUCKET_INDEX_KEY, ptr.bucketKey);
      }
    });
    await this.repo.logEvent({
      userId: actor.id,
      action: 'matchmaking.queue_exit',
      detail: { reason, retries: ptr.retries, waitedMs: Date.now() - ptr.firstQueuedAt },
    });
    return { left: true };
  }

  /** Pick a team in a TEAM_2V2 lobby (self-assign). Frozen once the lobby leaves OPEN. */
  async setPlayerTeam(actor: GameActor, code: string, team: GameTeam): Promise<unknown> {
    await this.assertRateLimit(actor.id, 'team', 30, 60);
    const lobby = await this.requireLobby(code);
    if (lobby.status !== GameLobbyStatus.OPEN) {
      throw this.conflict(ERROR_CODES.GAME_LOBBY_NOT_OPEN, 'This lobby is not open.');
    }
    if (lobby.mode !== GameMode.TEAM_2V2) {
      throw this.conflict(ERROR_CODES.GAME_NOT_TEAM_MODE, 'This lobby is not a 2v2 lobby.');
    }
    return this.locks.withLock(gameLobbyLockKey(lobby.id), async () => {
      const fresh = await this.repo.getLobbyById(lobby.id);
      if (!fresh || fresh.status !== GameLobbyStatus.OPEN) {
        throw this.conflict(ERROR_CODES.GAME_LOBBY_NOT_OPEN, 'This lobby is not open.');
      }
      if (!(await this.repo.getMember(fresh.id, actor.id))) {
        throw this.conflict(ERROR_CODES.GAME_NOT_IN_LOBBY, 'You are not in this lobby.');
      }
      const members = await this.repo.listMembersWithTeams(fresh.id);
      const onTeam = members.filter((m) => m.team === team && m.userId !== actor.id).length;
      if (onTeam >= 2) {
        throw this.conflict(ERROR_CODES.GAME_TEAM_FULL, `Team ${team} is already full.`);
      }
      await this.repo.setMemberTeam(fresh.id, actor.id, team);
      const updated = (await this.repo.listMembersWithTeams(fresh.id)).map((m) =>
        m.userId === actor.id ? { ...m, team } : m,
      );
      const teams = {
        A: updated.filter((m) => m.team === GameTeam.A).map((m) => m.userId),
        B: updated.filter((m) => m.team === GameTeam.B).map((m) => m.userId),
      };
      await this.repo.logEvent({
        lobbyId: fresh.id,
        userId: actor.id,
        action: 'lobby.team_changed',
        detail: { team },
      });
      await this.bus.publish(
        new GameLobbyTeamChangedEvent({
          v: MATCHMAKING_PROTOCOL_VERSION,
          code: fresh.code,
          userId: actor.id,
          team,
          teams,
        }),
      );
      return { userId: actor.id, team, teams };
    });
  }

  /** Toggle a lobby member's ready state. Only non-bot, non-host members need to signal ready. */
  async setLobbyReady(actor: GameActor, code: string, isReady: boolean): Promise<unknown> {
    await this.assertRateLimit(actor.id, 'ready', 10, 60);
    const lobby = await this.requireLobby(code);
    if (lobby.status !== GameLobbyStatus.OPEN) {
      throw this.conflict(ERROR_CODES.GAME_LOBBY_NOT_OPEN, 'This lobby is not open.');
    }
    return this.locks.withLock(gameLobbyLockKey(lobby.id), async () => {
      const fresh = await this.repo.getLobbyById(lobby.id);
      if (!fresh || fresh.status !== GameLobbyStatus.OPEN) {
        throw this.conflict(ERROR_CODES.GAME_LOBBY_NOT_OPEN, 'This lobby is not open.');
      }
      if (!(await this.repo.getMember(fresh.id, actor.id))) {
        throw this.conflict(ERROR_CODES.GAME_NOT_IN_LOBBY, 'You are not in this lobby.');
      }
      await this.repo.setMemberReady(fresh.id, actor.id, isReady);
      const rows = await this.repo.listMembersWithTeams(fresh.id);
      const humanIds = rows.filter((m) => !m.isBot).map((m) => m.userId);
      const identities = await this.resolveHumanIdentities(humanIds);
      const memberDetails = rows.map((m) => ({
        userId: m.userId,
        team: m.team,
        isBot: m.isBot,
        botName: m.botName,
        displayName: m.isBot ? m.botName : (identities.get(m.userId)?.displayName ?? null),
        avatar: m.isBot ? null : (identities.get(m.userId)?.avatarUrl ?? null),
        isReady: m.isBot ? true : m.userId === actor.id ? isReady : m.isReady,
      }));
      await this.bus.publish(
        new GameLobbyMemberReadyEvent({
          lobbyId: fresh.id,
          code: fresh.code,
          userId: actor.id,
          isReady,
          memberDetails,
        }),
      );
      return { userId: actor.id, isReady };
    });
  }

  // ======================= Matchmaking sweeps (monitor + shutdown) =======================

  /** Dissolve ready-checks past their deadline (index-driven, no SCAN). */
  async sweepExpiredReadyChecks(now: Date): Promise<void> {
    const due = await this.cache.sortedRangeByScore(GAME_MATCH_READY_INDEX_KEY, 0, now.getTime());
    for (const matchId of due) {
      try {
        await this.locks.withLock(gameMatchReadyLockKey(matchId), async () => {
          const state = await this.cache.get<ReadyCheckState>(gameMatchReadyKey(matchId));
          if (!state) {
            await this.cache.sortedRemove(GAME_MATCH_READY_INDEX_KEY, matchId);
            return;
          }
          if (Date.now() <= state.expiresAt) return; // rescheduled; not actually due
          await this.dissolveReadyCheck(state, 'timeout');
        });
      } catch (err) {
        this.logger.warn(`Failed to sweep ready-check ${matchId}: ${(err as Error).message}`);
      }
    }
  }

  /** Prune queue entries whose owners went stale (disconnected during downtime). */
  async sweepStaleQueueEntries(now: Date): Promise<void> {
    const cutoff = now.getTime() - matchQueueTtlSeconds() * 1000;
    const buckets = await this.cache.setMembers(GAME_MATCH_BUCKET_INDEX_KEY);
    for (const bucketKey of buckets) {
      try {
        await this.locks.withLock(gameMatchBucketLockKey(bucketKey), async () => {
          const stale = await this.cache.sortedRangeByScore(bucketKey, 0, cutoff);
          for (const id of stale) {
            await this.cache.sortedRemove(bucketKey, id);
            await this.cache.del(gameMatchUserKey(id));
            await this.repo.logEvent({
              userId: id,
              action: 'matchmaking.queue_exit',
              detail: { reason: 'stale' },
            });
          }
          if ((await this.cache.sortedCount(bucketKey)) === 0) {
            await this.cache.setRemove(GAME_MATCH_BUCKET_INDEX_KEY, bucketKey);
          }
        });
      } catch (err) {
        this.logger.warn(`Failed to prune bucket ${bucketKey}: ${(err as Error).message}`);
      }
    }
  }

  /** Best-effort graceful-shutdown drain: dissolve live ready-checks, re-queue the ready. */
  async drainMatchmaking(): Promise<void> {
    const all = await this.cache.sortedRangeByScore(
      GAME_MATCH_READY_INDEX_KEY,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    for (const matchId of all) {
      try {
        const state = await this.cache.get<ReadyCheckState>(gameMatchReadyKey(matchId));
        if (state) await this.dissolveReadyCheck(state, 'server_shutdown');
      } catch {
        // best-effort — another instance's monitor will sweep what we miss
      }
    }
  }

  private generatePublicId(): string {
    return randomBytes(16).toString('base64url');
  }

  private async enqueueMmTelemetry(event: string, payload: Record<string, unknown>): Promise<void> {
    await this.enqueueBestEffort(QUEUE_NAMES.ANALYTICS_PROCESSING, event, payload);
  }

  /**
   * Fire-and-forget telemetry/ranking enqueue. Must never throw: it always
   * runs after the financial state change it's reporting on (stake escrowed,
   * payout credited) has already committed, so a queue-backend hiccup here
   * must not surface as an error for an operation that actually succeeded.
   */
  private async enqueueBestEffort(
    queueName: QueueName,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.queue.enqueue(queueName, event, payload);
    } catch (err) {
      this.logger.warn(
        `Telemetry enqueue failed (${queueName}/${event}): ${(err as Error).message}`,
      );
    }
  }

  /** Fixed-window per-user rate limit for a matchmaking action (mirrors auth's limiter). */
  private async assertRateLimit(
    userId: string,
    action: string,
    limit: number,
    windowSeconds: number,
  ): Promise<void> {
    const count = await this.cache.increment(`game:mmrl:${action}:${userId}`, {
      ttlSeconds: windowSeconds,
    });
    if (count > limit) {
      throw new BusinessException(
        ERROR_CODES.RATE_LIMITED,
        'Too many matchmaking requests. Please slow down.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  // ======================= Expiry sweep =======================

  async sweepExpiredLobbies(now: Date): Promise<void> {
    const expired = await this.repo.findExpiredLobbies(now);
    for (const lobby of expired) {
      try {
        await this.locks.withLock(gameLobbyLockKey(lobby.id), async () => {
          const fresh = await this.repo.getLobbyById(lobby.id);
          if (!fresh || fresh.status !== GameLobbyStatus.OPEN) return;
          await this.repo.markLobbyClosed(fresh.id, GameLobbyStatus.EXPIRED, null);
          await this.repo.logEvent({ lobbyId: fresh.id, action: 'lobby.expired' });
          await this.bus.publish(
            new GameLobbyCancelledEvent({ lobbyId: fresh.id, code: fresh.code, reason: 'expired' }),
          );
        });
      } catch (err) {
        this.logger.warn(`Failed to expire lobby ${lobby.id}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Sweeps active sessions to check for any disconnected participants whose
   * reconnection timeout (GAME_DISCONNECT_GRACE_SECONDS) has expired.
   */
  async sweepExpiredDisconnections(now: Date): Promise<void> {
    const activeSessions = await this.repo.listActiveSessions();
    const graceMs = Math.max(0, GAME_DISCONNECT_GRACE_SECONDS) * 1000;
    for (const session of activeSessions) {
      const participants = await this.repo.listParticipants(session.id);
      for (const p of participants) {
        if (p.isBot || p.status !== GameParticipantStatus.PLAYING) continue;
        const ptr = await this.cache.get<GameDisconnectPointer>(gameDisconnectKey(p.userId));
        if (ptr && now.getTime() - ptr.disconnectedAt > graceMs) {
          await this.cache.del(gameDisconnectKey(p.userId));
          void this.forfeitOnDisconnect(p.userId);
        }
      }
    }
  }

  /**
   * Turn watchdog: recovers a stalled turn so a match can never freeze
   * indefinitely on one unresponsive seat (client crash/background, dropped
   * relay, a bot whose host stalled, etc). GAME_TURN_SECONDS is advisory —
   * clients drive the happy-path countdown — so this is the server-side
   * backstop, run on the same cadence as the other sweeps.
   *
   * Two-phase per session, gated on `turnStartedAt` staying identical between
   * phases (i.e. genuinely no move landed in between):
   *   1. Turn age > turnSeconds + GAME_TURN_STALL_GRACE_MS and no resync
   *      pending yet → request a resync from the room, stamp a pending
   *      marker for this turnStartedAt.
   *   2. Turn age > turnSeconds + GAME_TURN_STALL_GRACE_MS + GAME_TURN_RESYNC_GRACE_MS
   *      and the pending marker still matches this turnStartedAt → force-advance
   *      past the stuck seat. A seat that racks up
   *      GAME_MAX_CONSECUTIVE_TURN_TIMEOUTS force-advances in a row is folded
   *      into the normal disconnect/forfeit path, same as `forfeitOnDisconnect`.
   *
   * Everything that mutates live state runs under the session lock so this
   * can never race a genuine client-relayed move.
   */
  async sweepStalledTurns(now: Date): Promise<void> {
    const activeSessions = await this.repo.listActiveSessions();
    const nowMs = now.getTime();
    for (const session of activeSessions) {
      try {
        await this.sweepStalledTurnForSession(session, nowMs);
      } catch (err) {
        this.logger.warn(
          `Turn watchdog sweep failed for session ${session.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async sweepStalledTurnForSession(session: GameSession, nowMs: number): Promise<void> {
    // Cheap pre-check outside the lock — most sessions aren't stalled. Uses
    // the session's own turnSeconds (not the global default) so a
    // per-session/per-game turn clock is actually honored, not just stored.
    const peek = await this.cache.get<GameLiveState>(gameLiveStateKey(session.id));
    if (!peek || peek.isOver || !peek.currentTurnUserId) return;
    const peekThresholdMs = peek.turnSeconds * 1000 + GAME_TURN_STALL_GRACE_MS;
    if (nowMs - peek.turnStartedAt <= peekThresholdMs) return;

    await this.locks.withLock(gameSessionLockKey(session.id), async () => {
      const state = await this.loadOrInitLiveState(session);
      if (state.isOver || !state.currentTurnUserId) return;
      const stallThresholdMs = state.turnSeconds * 1000 + GAME_TURN_STALL_GRACE_MS;
      const turnAgeMs = nowMs - state.turnStartedAt;
      if (turnAgeMs <= stallThresholdMs) return;

      const pendingKey = gameTurnResyncPendingKey(session.id);
      const pending = await this.cache.get<{ turnStartedAt: number }>(pendingKey);

      if (!pending || pending.turnStartedAt !== state.turnStartedAt) {
        // Phase 1: first time we've seen this exact turn go stale — ask the
        // room to resync before we force anything, in case this is just a
        // desync/missed-broadcast rather than a genuinely stuck client.
        await this.cache.set(
          pendingKey,
          { turnStartedAt: state.turnStartedAt },
          GAME_TURN_RESYNC_PENDING_TTL_SECONDS,
        );
        await this.bus.publish(
          new GameTurnResyncRequestedEvent({
            sessionId: session.id,
            currentTurnUserId: state.currentTurnUserId,
            turnStartedAt: state.turnStartedAt,
          }),
        );
        return;
      }

      if (turnAgeMs <= stallThresholdMs + GAME_TURN_RESYNC_GRACE_MS) return;

      // Phase 2: still the same unresolved turn after the resync grace —
      // force-advance past the stuck seat so the match keeps moving.
      const stuckUserId = state.currentTurnUserId;
      const { state: advanced, skippedUserId, skippedStrikes } = forceAdvanceTurn(state, nowMs);
      await this.cache.set(gameLiveStateKey(session.id), advanced, GAME_LIVE_STATE_TTL_SECONDS);
      await this.cache.del(pendingKey);

      await this.repo.logEvent({
        sessionId: session.id,
        userId: skippedUserId ?? undefined,
        action: 'session.turn_force_advanced',
        detail: { skippedUserId, skippedStrikes, currentTurnUserId: advanced.currentTurnUserId },
      });
      await this.bus.publish(
        new GameTurnForceAdvancedEvent({
          sessionId: session.id,
          roomId: session.roomId,
          skippedUserId,
          skippedStrikes,
          currentTurnUserId: advanced.currentTurnUserId,
          rev: advanced.rev ?? 0,
        }),
      );

      // A seat that never completes a turn across several force-advances in a
      // row behaves like a client that's actually gone — fold it into the
      // same forfeit path a real disconnect would take, bot or human.
      if (stuckUserId && skippedStrikes >= GAME_MAX_CONSECUTIVE_TURN_TIMEOUTS) {
        void this.forfeitOnDisconnect(stuckUserId);
      }
    });
  }

  /**
   * Sweeps and aborts active sessions older than GAME_MAX_SESSION_DURATION_SECONDS
   * (e.g. 15 minutes), preventing abandoned matches from persisting in status ACTIVE.
   */
  async sweepStaleSessions(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - GAME_MAX_SESSION_DURATION_SECONDS * 1000);
    const staleSessions = await this.repo.findStaleActiveSessions(cutoff);
    for (const session of staleSessions) {
      try {
        // Routes through abortSession (takes its own gameSessionLockKey lock)
        // so every still-PLAYING participant is actually wallet-refunded with
        // a ledger row, instead of just flipping their DB status — see
        // abortSession/refundParticipants for the wallet-aware path.
        await this.abortSession(session.id, GameSessionStatus.ABORTED, null, 'stale_timeout');
      } catch (err) {
        // A concurrent settle/forfeit/cancel already moved the session out of
        // ACTIVE — abortSession's fresh re-check throws GAME_SESSION_NOT_ACTIVE,
        // which is an expected race here, not a failure to log loudly.
        this.logger.warn(`Failed to abort stale session ${session.id}: ${(err as Error).message}`);
      }
    }
  }

  // ======================= Reads =======================

  async getSession(actor: GameActor, sessionId: string): Promise<unknown> {
    const session = await this.repo.getSession(sessionId);
    if (!session) throw this.notFound(ERROR_CODES.GAME_SESSION_NOT_FOUND, 'Session not found.');
    await this.assertSessionViewable(actor, sessionId);
    const participants = await this.repo.listParticipants(sessionId);
    return this.sessionView(session, participants);
  }

  /**
   * Session detail and live board state carry other players' stakes,
   * payouts, win/loss outcomes, and identity — only a participant of the
   * session (or an admin) may read them. Without this, any authenticated
   * caller could enumerate session ids and read other users' financial and
   * personal data (an IDOR).
   */
  private async assertSessionViewable(actor: GameActor, sessionId: string): Promise<void> {
    if (this.isAdmin(actor)) return;
    const participant = await this.repo.getParticipant(sessionId, actor.id);
    if (participant) return;
    // Not a participant — still viewable read-only if this is a room-bound
    // session and the caller is a current member of that audio room
    // (spectator). A non-member falls through to the same rejection a
    // non-participant always got.
    const session = await this.repo.getSession(sessionId);
    if (session?.roomId && (await this.authz.isMember(session.roomId, actor.id))) return;
    throw new BusinessException(
      ERROR_CODES.GAME_NOT_AUTHORIZED,
      'You are not a participant of this session.',
      HttpStatus.FORBIDDEN,
    );
  }

  /**
   * Resume-on-launch: what should the client automatically route the actor
   * BACK into right now, if anything — checked ONLY for active matches and
   * temporary disconnections within the reconnect grace period (60s).
   *
   * Reconnect ONLY if:
   *   - Match status is WAITING, STARTING, or IN_PROGRESS.
   *   - The player is still an active participant (PLAYING).
   *   - The reconnect timeout has NOT expired.
   *
   * Otherwise returns { kind: 'none' }.
   */
  async getMyActiveMatch(actor: GameActor): Promise<unknown> {
    const activeSessionId = await this.repo.findActiveSessionForParticipant(actor.id);
    if (activeSessionId) {
      const session = await this.repo.getSession(activeSessionId);
      if (session && session.status === GameSessionStatus.ACTIVE) {
        // 1. Abort stale sessions older than max allowed duration (e.g. 15 minutes)
        const ageSeconds = (Date.now() - session.startedAt.getTime()) / 1000;
        if (ageSeconds > GAME_MAX_SESSION_DURATION_SECONDS) {
          try {
            await this.abortSession(session.id, GameSessionStatus.ABORTED, null, 'stale_timeout');
          } catch (err) {
            // Another request/the sweep monitor may have already aborted it —
            // that's fine, we still want to report "nothing active" below.
            this.logger.warn(
              `Failed to abort stale session ${session.id} on active-match check: ${(err as Error).message}`,
            );
          }
          return { kind: 'none' };
        }

        // 2. Check if player has a disconnect record in Redis exceeding 60s
        const disconnectPtr = await this.cache.get<GameDisconnectPointer>(
          gameDisconnectKey(actor.id),
        );
        if (disconnectPtr) {
          const elapsedMs = Date.now() - disconnectPtr.disconnectedAt;
          const graceMs = Math.max(0, GAME_DISCONNECT_GRACE_SECONDS) * 1000;
          if (elapsedMs > graceMs) {
            await this.cache.del(gameDisconnectKey(actor.id));
            void this.forfeitOnDisconnect(actor.id);
            return { kind: 'none' };
          }
        }

        const participants = await this.repo.listParticipants(activeSessionId);
        return { kind: 'session', session: await this.sessionView(session, participants) };
      }
    }
    const lobbyCode = await this.repo.findActiveLobbyForParticipant(actor.id);
    if (lobbyCode) {
      const lobby = await this.repo.getLobbyByCode(lobbyCode);
      if (lobby && lobby.status === GameLobbyStatus.OPEN) {
        return {
          kind: 'lobby',
          lobby: await this.lobbyView(lobby, await this.gameCodeOf(lobby.definitionId)),
        };
      }
    }
    return { kind: 'none' };
  }

  /** Marks the actor's result for [sessionId] as acknowledged (idempotent, no-op if not a participant). */
  async ackResult(actor: GameActor, sessionId: string): Promise<void> {
    await this.repo.markResultSeen(sessionId, actor.id);
  }

  async getLobby(code: string): Promise<unknown> {
    const lobby = await this.requireLobby(code);
    return this.lobbyView(lobby, await this.gameCodeOf(lobby.definitionId));
  }

  async listOpenLobbies(page: number, limit: number, skip: number): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listOpenLobbies(skip, limit);
    // Resolve definitionId -> gameCode once for the whole page instead of once
    // per lobby (lobbyView's own fallback does a full table scan every call).
    const defs = await this.repo.listDefinitions(false);
    const codeByDefinitionId = new Map(defs.map((d) => [d.id, d.code]));
    const views = await Promise.all(
      rows.map((l) => this.lobbyView(l, codeByDefinitionId.get(l.definitionId))),
    );
    return buildPaginated(views, total, page, limit);
  }

  /**
   * What's currently happening with games in this audio room — the active
   * session (if a match has started) or the open lobby (if the host has
   * created one but not started it yet), so the room's UI can render
   * "Start"/"Join"/"Watch" without the caller ever supplying a session/lobby
   * id it would otherwise have to already know. Gated on current room
   * membership — this is the one seam that would otherwise let a non-member
   * probe whether a private room has a lobby open.
   */
  async getRoomGameStatus(
    actor: GameActor,
    roomId: string,
  ): Promise<{ activeSession: unknown; openLobby: unknown }> {
    await this.authz.assertCanWatch(roomId, actor.id);
    const [session, lobby] = await Promise.all([
      this.repo.findActiveSessionForRoom(roomId),
      this.repo.findOpenLobbyForRoom(roomId),
    ]);
    const [activeSession, openLobby] = await Promise.all([
      session ? this.sessionView(session, await this.repo.listParticipants(session.id)) : null,
      lobby ? this.lobbyView(lobby, await this.gameCodeOf(lobby.definitionId)) : null,
    ]);
    return { activeSession, openLobby };
  }

  async history(actor: GameActor, dto: ListSessionsDto): Promise<Paginated<unknown>> {
    let definitionId: string | undefined;
    if (dto.gameCode) {
      const def = await this.repo.getDefinitionByCode(dto.gameCode);
      if (!def) return buildPaginated([], 0, dto.page, dto.limit);
      definitionId = def.id;
    }
    const sessionIds = await this.repo.listUserSessionIds(actor.id, definitionId);
    if (!sessionIds.length) return buildPaginated([], 0, dto.page, dto.limit);
    const [rows, total] = await this.repo.listSessions(
      { id: { in: sessionIds } },
      dto.skip,
      dto.limit,
    );
    const parts = await this.prisma.gameParticipant.findMany({
      where: { sessionId: { in: rows.map((r) => r.id) }, userId: actor.id },
    });
    const partMap = new Map<string, GameParticipant>(
      parts.map((p: GameParticipant) => [p.sessionId, p]),
    );
    return buildPaginated(
      rows.map((s) => {
        const p = partMap.get(s.id);
        return {
          ...this.sessionSummary(s),
          participantStatus: p?.status ?? 'PLAYING',
          isWinner: p?.isWinner ?? false,
          payoutAmount: Number(p?.payoutAmount ?? 0),
          stakeAmount: Number(p?.stake ?? s.stake),
        };
      }),
      total,
      dto.page,
      dto.limit,
    );
  }

  async luckyRecords(
    actor: GameActor,
    dto: { page?: number; limit?: number; skip?: number },
  ): Promise<Paginated<unknown>> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const skip = dto.skip ?? (page - 1) * limit;

    const [bets, totalBets] = await Promise.all([
      this.prisma.casinoBet.findMany({
        where: { userId: actor.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { round: true },
      }),
      this.prisma.casinoBet.count({ where: { userId: actor.id } }),
    ]);

    const items = bets.map((b) => {
      const gameName = b.game === 'GREEDY_FOOD' ? 'Greedy Food' : 'Lucky Fruit';
      const betAmount = Number(b.betAmount);
      const payoutAmount = Number(b.payoutAmount);
      return {
        id: b.id,
        gameName,
        gameCode: b.game,
        luckyResult: b.round?.winningOutcome
          ? `${b.betItem} (Winning: ${b.round.winningOutcome})`
          : b.betItem,
        coinsSpent: betAmount,
        coinsWon: payoutAmount,
        reward: payoutAmount,
        status: b.status,
        createdAt: b.createdAt,
      };
    });

    return buildPaginated(items, totalBets, page, limit);
  }

  async jackpotRecords(
    actor: GameActor,
    dto: { page?: number; limit?: number; skip?: number },
  ): Promise<Paginated<unknown>> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const skip = dto.skip ?? (page - 1) * limit;

    const [entries, total] = await Promise.all([
      this.prisma.jackpotEntry.findMany({
        where: { userId: actor.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { jackpot: true },
      }),
      this.prisma.jackpotEntry.count({ where: { userId: actor.id } }),
    ]);

    const items = entries.map((e) => {
      const entryFee = Number(e.entryFee);
      const payoutAmount = Number(e.payoutAmount);
      return {
        id: e.id,
        jackpotName: e.jackpot?.name ?? 'Jackpot',
        jackpotCode: e.jackpot?.code ?? 'JACKPOT',
        entryAmount: entryFee,
        coinsContributed: entryFee,
        payoutAmount,
        reward: payoutAmount,
        status: e.status,
        result: e.status === 'WON' ? 'Won' : e.status === 'LOST' ? 'Lost' : e.status,
        createdAt: e.createdAt,
      };
    });

    return buildPaginated(items, total, page, limit);
  }

  async myTournaments(
    actor: GameActor,
    dto: { page?: number; limit?: number; skip?: number },
  ): Promise<Paginated<unknown>> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const skip = dto.skip ?? (page - 1) * limit;

    const [participants, total] = await Promise.all([
      this.prisma.eventParticipant.findMany({
        where: {
          userId: actor.id,
          event: { category: 'TOURNAMENT' },
        },
        orderBy: { joinedAt: 'desc' },
        skip,
        take: limit,
        include: { event: true },
      }),
      this.prisma.eventParticipant.count({
        where: {
          userId: actor.id,
          event: { category: 'TOURNAMENT' },
        },
      }),
    ]);

    const rewards = await this.prisma.eventReward.findMany({
      where: {
        userId: actor.id,
        eventId: { in: participants.map((p) => p.eventId) },
      },
    });
    const rewardMap = new Map(rewards.map((r) => [r.eventId, r]));

    const items = participants.map((p, idx) => {
      const rewardRow = rewardMap.get(p.eventId);
      let rewardAmount = 0;
      if (rewardRow?.rewardDefinition && typeof rewardRow.rewardDefinition === 'object') {
        const def = rewardRow.rewardDefinition as Record<string, unknown>;
        rewardAmount = Number(def.coins ?? def.amount ?? 0);
      }
      return {
        id: p.id,
        eventId: p.eventId,
        tournamentName: p.event?.name ?? 'Tournament',
        status: p.event?.status ?? 'COMPLETED',
        participantStatus: p.status,
        score: Number(p.score),
        rank: idx + 1,
        participantsCount: p.event?.maxParticipants ?? 100,
        reward: rewardAmount,
        entryFee: 0,
        createdAt: p.joinedAt,
      };
    });

    return buildPaginated(items, total, page, limit);
  }

  async listTournaments(dto: {
    page?: number;
    limit?: number;
    skip?: number;
  }): Promise<Paginated<unknown>> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const skip = dto.skip ?? (page - 1) * limit;

    const [events, total] = await Promise.all([
      this.prisma.eventDefinition.findMany({
        where: { category: 'TOURNAMENT' },
        orderBy: { startTime: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.eventDefinition.count({ where: { category: 'TOURNAMENT' } }),
    ]);

    const items = events.map((e) => ({
      id: e.id,
      code: e.code,
      name: e.name,
      description: e.description,
      status: e.status,
      startTime: e.startTime,
      endTime: e.endTime,
      maxParticipants: e.maxParticipants,
    }));

    return buildPaginated(items, total, page, limit);
  }

  async leaderboard(limit: number): Promise<unknown[]> {
    const rows = await this.cache.top(GAME_WINS_LEADERBOARD_KEY, limit);
    const users = await Promise.all(rows.map((r) => this.users.findById(r.member)));
    return rows.map((r, i) => ({
      rank: i + 1,
      userId: r.member,
      username: users[i]?.username ?? null,
      wins: r.score,
    }));
  }

  // ======================= Internals =======================

  /**
   * Acquire the wallet lock for each of `userIds` (deduped, sorted to avoid
   * deadlock against another caller locking the same set) before running `fn`.
   * Needed wherever we pass a shared `tx` into wallet.credit/debit: that makes
   * the movement join our transaction instead of taking wallet's own internal
   * per-user lock, so we take that same lock here for the whole transaction.
   */
  private async withWalletLocks<T>(userIds: string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(userIds)].sort();
    const run = (i: number): Promise<T> =>
      i >= sorted.length ? fn() : this.locks.withLock(walletLockKey(sorted[i]), () => run(i + 1));
    return run(0);
  }

  private async loadOrInitLiveState(session: GameSession): Promise<GameLiveState> {
    const cached = await this.cache.get<GameLiveState>(gameLiveStateKey(session.id));
    // A session that was already live when `rev` shipped has no revision in
    // its cached JSON. Normalize it to 0 here — once — so every caller
    // downstream can treat `rev` as a plain number instead of repeating the
    // fallback (and so the first move on such a session emits rev 1, not NaN).
    if (cached) return cached.rev === undefined ? { ...cached, rev: 0 } : cached;
    // Only reached if the Redis key is missing mid-match (TTL/eviction/ops
    // incident) — a legitimate first-init happens exactly once, right after
    // start. Log it: silently fabricating a fresh state here resets the move
    // log and turn order from every client's perspective. Seed the rotation
    // from currently-PLAYING seats only, so an already-forfeited participant
    // doesn't reappear in the rotation.
    this.logger.warn(
      `Live state for session ${session.id} was missing in cache — reinitializing from DB.`,
    );
    const participants = await this.repo.listParticipants(session.id);
    return initLiveState(
      participants.filter((p) => p.status === GameParticipantStatus.PLAYING).map((p) => p.userId),
      session.startedAt.getTime(),
      GAME_TURN_SECONDS,
    );
  }

  /** Even split of `total` across winners; any remainder goes to the earliest winners. */
  private splitPot(total: number, winners: string[]): { userId: string; amount: number }[] {
    const base = Math.floor(total / winners.length);
    const remainder = total - base * winners.length;
    return winners.map((userId, i) => ({ userId, amount: base + (i < remainder ? 1 : 0) }));
  }

  private async refundParticipants(
    session: GameSession,
    participants: GameParticipant[],
  ): Promise<string[]> {
    const refunded: string[] = [];
    for (const p of participants) {
      try {
        const credit = await this.wallet.credit({
          userId: p.userId,
          currency: this.walletCurrency(session.currency),
          amount: Number(p.stake),
          reason: WalletTxnReason.GAME_REFUND,
          idempotencyKey: `game-refund:${session.id}:${p.userId}`,
          referenceType: 'game_session',
          referenceId: session.id,
          metadata: { gameCode: session.code },
          actorId: p.userId,
        });
        await this.repo.createTransaction({
          sessionId: session.id,
          participantId: p.id,
          userId: p.userId,
          type: GameTxnType.REFUND,
          currency: session.currency,
          amount: p.stake,
          walletTxnId: credit.transactionId,
          idempotencyKey: `game-refund:${session.id}:${p.userId}`,
        });
        await this.repo.updateParticipant(p.id, {
          status: GameParticipantStatus.REFUNDED,
          refundTxnId: credit.transactionId,
          settledAt: new Date(),
        });
        refunded.push(p.userId);
      } catch (err) {
        // A refund must never block the cancel — log for manual reconciliation.
        this.logger.error(
          `Game refund failed for user ${p.userId} in session ${session.id}: ${(err as Error).message}`,
        );
      }
    }
    return refunded;
  }

  private validateSettlement(
    session: GameSession,
    participants: GameParticipant[],
    participantIds: Set<string>,
    input: SettleResultInput,
  ): Map<string, number> {
    for (const w of input.winners) {
      if (!participantIds.has(w)) {
        throw new BusinessException(
          ERROR_CODES.GAME_INVALID_PARTICIPANT,
          'A winner is not a participant of this session.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    const payoutMap = new Map<string, number>();
    for (const entry of input.payouts) {
      if (!participantIds.has(entry.userId)) {
        throw new BusinessException(
          ERROR_CODES.GAME_INVALID_PARTICIPANT,
          'A payout target is not a participant of this session.',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (payoutMap.has(entry.userId)) {
        throw new BusinessException(
          ERROR_CODES.GAME_INVALID_PAYOUT,
          'Duplicate payout entry for a participant.',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (entry.amount < 0) {
        throw new BusinessException(
          ERROR_CODES.GAME_INVALID_PAYOUT,
          'Payout amounts cannot be negative.',
          HttpStatus.BAD_REQUEST,
        );
      }
      payoutMap.set(entry.userId, entry.amount);
    }
    // Anti-cheat: payouts cannot exceed the escrowed pot (no coin minting).
    const payoutTotal = [...payoutMap.values()].reduce((a, b) => a + b, 0);
    if (payoutTotal > Number(session.potAmount)) {
      throw new BusinessException(
        ERROR_CODES.GAME_PAYOUT_EXCEEDS_POT,
        'Total payouts exceed the session pot.',
        HttpStatus.BAD_REQUEST,
      );
    }
    // Sanity: recorded pot must equal the sum of participant stakes.
    const stakeSum = participants.reduce((a, p) => a + p.stake, 0n);
    if (stakeSum !== session.potAmount) {
      throw new BusinessException(
        ERROR_CODES.GAME_INVALID_PAYOUT,
        'Session pot does not reconcile with staked amounts.',
        HttpStatus.CONFLICT,
      );
    }
    return payoutMap;
  }

  private async requireEnabledDefinition(code: GameCode): Promise<GameDefinition> {
    const def = await this.repo.getDefinitionByCode(code);
    if (!def) throw this.notFound(ERROR_CODES.GAME_NOT_FOUND, 'Game not found.');
    if (!def.enabled) {
      throw this.conflict(ERROR_CODES.GAME_DISABLED, 'This game is currently disabled.');
    }
    return def;
  }

  /** Host-only guard shared by kick/close/settings. */
  private assertHost(hostId: string, actorId: string, message: string): void {
    if (hostId !== actorId) {
      throw new BusinessException(ERROR_CODES.GAME_NOT_HOST, message, HttpStatus.FORBIDDEN);
    }
  }

  /** Gate TEAM_2V2 to games whose engine actually implements the positional split. */
  private assert2v2Supported(gameCode: GameCode): void {
    if (!TEAM_2V2_CAPABLE_GAMES.has(gameCode)) {
      throw this.conflict(ERROR_CODES.GAME_2V2_UNSUPPORTED, 'This game does not support 2v2.');
    }
  }

  private assertStakeInRange(def: GameDefinition, stake: number): void {
    // stake 0 = friendly (no-stake) match — allowed for any game, bypasses the range.
    if (stake === 0) return;
    if (BigInt(stake) < def.minStake || BigInt(stake) > def.maxStake) {
      throw new BusinessException(
        ERROR_CODES.GAME_INVALID_STAKE,
        `Stake must be between ${def.minStake} and ${def.maxStake}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async assertCanAfford(
    userId: string,
    currency: GameCurrency,
    stake: bigint,
  ): Promise<void> {
    const balances = await this.wallet.getBalance(userId);
    const available = currency === GameCurrency.GOLD ? balances.gold : balances.game;
    if (BigInt(available) < stake) {
      throw new BusinessException(
        ERROR_CODES.INSUFFICIENT_BALANCE,
        'Insufficient balance to join this game.',
        HttpStatus.CONFLICT,
      );
    }
  }

  private async requireLobby(code: string): Promise<GameLobby> {
    const lobby = await this.repo.getLobbyByCode(code.toUpperCase());
    if (!lobby) throw this.notFound(ERROR_CODES.GAME_LOBBY_NOT_FOUND, 'Lobby not found.');
    return lobby;
  }

  private async generateJoinCode(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      let code = '';
      for (let i = 0; i < GAME_JOIN_CODE_LENGTH; i++) {
        code += GAME_JOIN_CODE_ALPHABET[randomInt(GAME_JOIN_CODE_ALPHABET.length)];
      }
      if (!(await this.repo.getLobbyByCode(code))) return code;
    }
    throw new BusinessException(
      ERROR_CODES.CONFLICT,
      'Could not allocate a lobby code, please retry.',
      HttpStatus.CONFLICT,
    );
  }

  private async gameCodeOf(definitionId: string): Promise<GameCode> {
    const defs = await this.repo.listDefinitions(false);
    const def = defs.find((d) => d.id === definitionId);
    if (!def) throw this.notFound(ERROR_CODES.GAME_NOT_FOUND, 'Game not found.');
    return def.code;
  }

  private walletCurrency(currency: GameCurrency): WalletCurrency {
    return currency === GameCurrency.GOLD
      ? WalletCurrency.GOLD
      : currency === GameCurrency.GAME
        ? WalletCurrency.GAME
        : WalletCurrency.FREE;
  }

  private isAdmin(actor: GameActor): boolean {
    return actor.roles.some((r) => ADMIN_ROLES.has(r));
  }

  private assertAdmin(actor: GameActor): void {
    if (!this.isAdmin(actor)) {
      throw new BusinessException(
        ERROR_CODES.GAME_NOT_AUTHORIZED,
        'Administrator role required.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private notFound(code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES], msg: string) {
    return new BusinessException(code, msg, HttpStatus.NOT_FOUND);
  }

  private conflict(code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES], msg: string) {
    return new BusinessException(code, msg, HttpStatus.CONFLICT);
  }

  private definitionView(d: GameDefinition) {
    return {
      code: d.code,
      name: d.name,
      category: d.category,
      currency: d.currency,
      minPlayers: d.minPlayers,
      maxPlayers: d.maxPlayers,
      minStake: Number(d.minStake),
      maxStake: Number(d.maxStake),
      houseRakeBps: d.houseRakeBps,
      enabled: d.enabled,
    };
  }

  private async lobbyView(
    lobby: GameLobby,
    gameCode: GameCode | undefined,
  ): Promise<GameLobbyView> {
    const rows = await this.repo.listMembersWithTeams(lobby.id);
    const humanIds = rows.filter((m) => !m.isBot).map((m) => m.userId);
    const identities = await this.resolveHumanIdentities(humanIds);
    return {
      lobbyId: lobby.id,
      code: lobby.code,
      gameCode: gameCode ?? (await this.gameCodeOf(lobby.definitionId)),
      hostId: lobby.hostId,
      roomId: lobby.roomId,
      currency: lobby.currency,
      stake: Number(lobby.stake),
      maxPlayers: lobby.maxPlayers,
      mode: lobby.mode,
      carromMode: lobby.carromMode,
      teamCoinAssignment: lobby.teamCoinAssignment,
      isPrivate: lobby.isPrivate,
      hasPassword: lobby.passwordHash != null,
      members: rows.map((m) => m.userId),
      memberDetails: rows.map((m) => ({
        userId: m.userId,
        team: m.team,
        isBot: m.isBot,
        botName: m.botName,
        displayName: m.isBot ? m.botName : (identities.get(m.userId)?.displayName ?? null),
        avatar: m.isBot ? null : (identities.get(m.userId)?.avatarUrl ?? null),
        isReady: m.isBot ? true : m.isReady,
      })),
    };
  }

  private async sessionView(session: GameSession, participants: GameParticipant[]) {
    const sorted = [...participants].sort((a, b) => a.seat - b.seat);
    const humanIds = sorted.filter((p) => !p.isBot).map((p) => p.userId);
    const botIds = sorted.filter((p) => p.isBot).map((p) => p.userId);
    const [identities, botNames] = await Promise.all([
      this.resolveHumanIdentities(humanIds),
      this.resolveBotNames(session.lobbyId, botIds),
    ]);
    return {
      id: session.id,
      gameCode: session.code,
      joinCode: session.joinCode,
      hostId: session.hostId,
      roomId: session.roomId,
      currency: session.currency,
      stake: Number(session.stake),
      potAmount: Number(session.potAmount),
      mode: session.mode,
      carromMode: session.carromMode,
      teamCoinAssignment: session.teamCoinAssignment,
      status: session.status,
      startedAt: session.startedAt,
      settledAt: session.settledAt,
      // seat order is authoritative (turn order + positional 2v2 team split).
      participants: sorted.map((p) => ({
        userId: p.userId,
        seat: p.seat,
        team: p.team,
        isBot: p.isBot,
        status: p.status,
        isWinner: p.isWinner,
        payoutAmount: Number(p.payoutAmount),
        displayName: p.isBot
          ? (botNames.get(p.userId) ?? null)
          : (identities.get(p.userId)?.displayName ?? null),
        avatar: p.isBot ? null : (identities.get(p.userId)?.avatarUrl ?? null),
      })),
    };
  }

  /**
   * Batch-resolve displayName + avatar for HUMAN participants/members ONCE per
   * view build. Bots are never looked up here — they carry their own botName.
   */
  private async resolveHumanIdentities(
    userIds: string[],
  ): Promise<Map<string, { displayName: string | null; avatarUrl: string | null }>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();
    return this.profiles.resolvePublicIdentities(unique);
  }

  /**
   * A session's participants carry no name of their own — a bot's display name
   * lives on the lobby seat that spawned it (game_lobby_members.botName). Falls
   * back to an empty map (null display names) if there's no bot to resolve or
   * no lobby to resolve it from.
   */
  private async resolveBotNames(
    lobbyId: string | null,
    botIds: string[],
  ): Promise<Map<string, string | null>> {
    const names = new Map<string, string | null>();
    if (botIds.length === 0 || !lobbyId) return names;
    const rows = await this.repo.listMembersWithTeams(lobbyId);
    for (const row of rows) if (row.isBot) names.set(row.userId, row.botName);
    return names;
  }

  private sessionSummary(session: GameSession) {
    return {
      id: session.id,
      gameCode: session.code,
      currency: session.currency,
      stake: Number(session.stake),
      potAmount: Number(session.potAmount),
      status: session.status,
      startedAt: session.startedAt,
      settledAt: session.settledAt,
    };
  }
}
