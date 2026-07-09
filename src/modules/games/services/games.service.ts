import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import {
  GameCode,
  GameCurrency,
  GameDefinition,
  GameLobby,
  GameLobbyStatus,
  GameParticipant,
  GameParticipantStatus,
  GameSession,
  GameSessionStatus,
  GameTxnType,
  WalletCurrency,
  WalletTxnReason,
} from '@prisma/client';
import type { PlatformRole } from 'src/common/constants';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { CacheService } from 'src/infra/redis/cache.service';
import { LockService } from 'src/infra/redis/lock.service';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import {
  GAME_JOIN_CODE_ALPHABET,
  GAME_JOIN_CODE_LENGTH,
  GAME_LOBBY_TTL_MS,
  GAME_WINS_LEADERBOARD_KEY,
  gameLobbyLockKey,
  gameSessionLockKey,
  gameWinningsLeaderboardKey,
} from '../constants/games.constants';
import type { CreateLobbyDto, ListSessionsDto, UpdateGameDefinitionDto } from '../dto/games.dto';
import {
  GameCancelledEvent,
  GameLobbyCancelledEvent,
  GameLobbyCreatedEvent,
  GameLobbyJoinedEvent,
  GameLobbyLeftEvent,
  GameSettledEvent,
  GameStartedEvent,
  type GameLobbyView,
} from '../events/game.events';
import type { GameActor } from '../interfaces/game-actor.interface';
import { GamesRepository } from '../repositories/games.repository';

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
    private readonly locks: LockService,
    private readonly cache: CacheService,
    private readonly queue: QueueService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
  ) {}

  // ======================= Catalog =======================

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
    const def = await this.requireEnabledDefinition(dto.gameCode);
    this.assertStakeInRange(def, dto.stake);

    const code = await this.generateJoinCode();
    const lobby = await this.repo.createLobby({
      definitionId: def.id,
      code,
      hostId: actor.id,
      roomId: dto.roomId ?? null,
      category: def.category,
      currency: def.currency,
      stake: BigInt(dto.stake),
      maxPlayers: def.maxPlayers,
      status: GameLobbyStatus.OPEN,
      expiresAt: new Date(Date.now() + GAME_LOBBY_TTL_MS),
      createdBy: actor.id,
    });
    await this.repo.addMember(lobby.id, actor.id);
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

  async joinLobby(actor: GameActor, code: string): Promise<unknown> {
    const lobby = await this.requireLobby(code);
    if (lobby.status !== GameLobbyStatus.OPEN) {
      throw this.conflict(ERROR_CODES.GAME_LOBBY_NOT_OPEN, 'This lobby is not open.');
    }
    return this.locks.withLock(gameLobbyLockKey(lobby.id), async () => {
      const fresh = await this.repo.getLobbyById(lobby.id);
      if (!fresh || fresh.status !== GameLobbyStatus.OPEN) {
        throw this.conflict(ERROR_CODES.GAME_LOBBY_NOT_OPEN, 'This lobby is not open.');
      }
      if (await this.repo.getMember(fresh.id, actor.id)) {
        throw this.conflict(ERROR_CODES.GAME_ALREADY_IN_LOBBY, 'You are already in this lobby.');
      }
      if ((await this.repo.countMembers(fresh.id)) >= fresh.maxPlayers) {
        throw this.conflict(ERROR_CODES.GAME_LOBBY_FULL, 'This lobby is full.');
      }
      await this.assertCanAfford(actor.id, fresh.currency, fresh.stake);
      await this.repo.addMember(fresh.id, actor.id);
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
    return this.locks.withLock(gameLobbyLockKey(lobby.id), async () => {
      const fresh = await this.repo.getLobbyById(lobby.id);
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

      // Create the session + participants, then escrow each stake. Any failed
      // debit refunds everything already taken and aborts the session.
      const session = await this.repo.createSession({
        definitionId: def.id,
        code: def.code,
        lobbyId: fresh.id,
        joinCode: fresh.code,
        hostId: fresh.hostId,
        roomId: fresh.roomId,
        category: def.category,
        currency: def.currency,
        stake: fresh.stake,
        playerCount: members.length,
        status: GameSessionStatus.ACTIVE,
        createdBy: actor.id,
      });
      await this.repo.createParticipants(
        members.map((userId) => ({
          sessionId: session.id,
          definitionId: def.id,
          userId,
          stake: fresh.stake,
        })),
      );
      const participants = await this.repo.listParticipants(session.id);

      const escrowed: GameParticipant[] = [];
      try {
        for (const p of participants) {
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
          escrowed.push(p);
        }
      } catch (err) {
        await this.refundParticipants(session, escrowed);
        await this.repo.closeSession(session.id, GameSessionStatus.ABORTED, actor.id);
        await this.repo.logEvent({
          sessionId: session.id,
          lobbyId: fresh.id,
          action: 'session.aborted',
          detail: { reason: 'stake_failed', staked: escrowed.length },
        });
        throw err;
      }

      const potAmount = session.stake * BigInt(members.length);
      await this.repo.setSessionPot(session.id, potAmount);
      await this.repo.markLobbyStarted(fresh.id, session.id, actor.id);
      await this.repo.logEvent({
        sessionId: session.id,
        lobbyId: fresh.id,
        userId: actor.id,
        action: 'session.started',
        detail: { potAmount: Number(potAmount), players: members.length },
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
        }),
      );
      await this.queue.enqueue(QUEUE_NAMES.ANALYTICS_PROCESSING, 'game.started', {
        sessionId: session.id,
        gameCode: def.code,
        players: members.length,
        potAmount: Number(potAmount),
      });
      return this.sessionView({ ...session, potAmount }, participants);
    });
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
    return this.abortSession(sessionId, GameSessionStatus.CANCELLED, actor.id, 'host_cancel');
  }

  /** Trusted settlement seam — validates and pays out; never decides winners. */
  async settleResult(input: SettleResultInput): Promise<unknown> {
    const session = await this.repo.getSession(input.sessionId);
    if (!session) throw this.notFound(ERROR_CODES.GAME_SESSION_NOT_FOUND, 'Session not found.');

    return this.locks.withLock(gameSessionLockKey(session.id), async () => {
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

      // Credit winners. Idempotency keys make a retry after a partial failure safe.
      for (const p of participants) {
        const payout = payoutMap.get(p.userId) ?? 0;
        const isWinner = input.winners.includes(p.userId);
        let payoutTxnId: string | null = null;
        if (payout > 0) {
          const credit = await this.wallet.credit({
            userId: p.userId,
            currency: this.walletCurrency(fresh.currency),
            amount: payout,
            reason: WalletTxnReason.GAME_PAYOUT,
            idempotencyKey: `game-payout:${fresh.id}:${p.userId}`,
            referenceType: 'game_session',
            referenceId: fresh.id,
            metadata: { gameCode: fresh.code },
            actorId: p.userId,
          });
          payoutTxnId = credit.transactionId;
          await this.repo.createTransaction({
            sessionId: fresh.id,
            participantId: p.id,
            userId: p.userId,
            type: GameTxnType.PAYOUT,
            currency: fresh.currency,
            amount: BigInt(payout),
            walletTxnId: credit.transactionId,
            idempotencyKey: `game-payout:${fresh.id}:${p.userId}`,
          });
        }
        await this.repo.updateParticipant(p.id, {
          status: isWinner ? GameParticipantStatus.WON : GameParticipantStatus.LOST,
          isWinner,
          payoutAmount: BigInt(payout),
          payoutTxnId,
          settledAt: new Date(),
        });
      }

      await this.repo.createMatchResult({
        sessionId: fresh.id,
        definitionId: fresh.definitionId,
        code: fresh.code,
        potAmount: fresh.potAmount,
        payoutTotal: BigInt(payoutTotal),
        rakeAmount: BigInt(rakeAmount),
        winners: input.winners,
        resultData: input.resultData ?? {},
        settledBy: input.settledBy ?? null,
      });
      await this.repo.completeSession(fresh.id, input.settledBy ?? null);
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
        }),
      );
      await this.queue.enqueue(QUEUE_NAMES.ANALYTICS_PROCESSING, 'game.settled', {
        sessionId: fresh.id,
        gameCode: fresh.code,
        payoutTotal,
        rakeAmount,
      });
      await this.queue.enqueue(QUEUE_NAMES.RANKING_PROCESSING, 'game.settled', {
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
    });
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
      const refundable = participants.filter(
        (p) => p.stakeTxnId && p.status === GameParticipantStatus.PLAYING,
      );
      const refunded = await this.refundParticipants(fresh, refundable);
      await this.repo.closeSession(fresh.id, status, actorId);
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

  // ======================= Reads =======================

  async getSession(sessionId: string): Promise<unknown> {
    const session = await this.repo.getSession(sessionId);
    if (!session) throw this.notFound(ERROR_CODES.GAME_SESSION_NOT_FOUND, 'Session not found.');
    const participants = await this.repo.listParticipants(sessionId);
    return this.sessionView(session, participants);
  }

  async getLobby(code: string): Promise<unknown> {
    const lobby = await this.requireLobby(code);
    return this.lobbyView(lobby, await this.gameCodeOf(lobby.definitionId));
  }

  async listOpenLobbies(page: number, limit: number, skip: number): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listOpenLobbies(skip, limit);
    const views = await Promise.all(rows.map((l) => this.lobbyView(l, undefined)));
    return buildPaginated(views, total, page, limit);
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
    return buildPaginated(
      rows.map((s) => this.sessionSummary(s)),
      total,
      dto.page,
      dto.limit,
    );
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

  private assertStakeInRange(def: GameDefinition, stake: number): void {
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
    const available = currency === GameCurrency.GOLD ? balances.gold : balances.free;
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
    return currency === GameCurrency.GOLD ? WalletCurrency.GOLD : WalletCurrency.FREE;
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
    const members = await this.repo.listMemberIds(lobby.id);
    return {
      lobbyId: lobby.id,
      code: lobby.code,
      gameCode: gameCode ?? (await this.gameCodeOf(lobby.definitionId)),
      hostId: lobby.hostId,
      roomId: lobby.roomId,
      currency: lobby.currency,
      stake: Number(lobby.stake),
      maxPlayers: lobby.maxPlayers,
      members,
    };
  }

  private sessionView(session: GameSession, participants: GameParticipant[]) {
    return {
      id: session.id,
      gameCode: session.code,
      joinCode: session.joinCode,
      hostId: session.hostId,
      roomId: session.roomId,
      currency: session.currency,
      stake: Number(session.stake),
      potAmount: Number(session.potAmount),
      status: session.status,
      startedAt: session.startedAt,
      settledAt: session.settledAt,
      participants: participants.map((p) => ({
        userId: p.userId,
        status: p.status,
        isWinner: p.isWinner,
        payoutAmount: Number(p.payoutAmount),
      })),
    };
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
