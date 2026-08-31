/**
 * The audio-room casino window — the room-bound integration of the existing
 * house-banked casino games (Greedy Food, Lucky Fruit) into an Audio Room.
 *
 * A "window" is a room-bound `GameSession` presence marker (code GREEDY_FOOD /
 * LUCKY_FRUIT, `roomId` set, no lobby, no participants, no stake) created when
 * the room OWNER starts a Gold Coin game in the room. It is NOT a second
 * casino: the actual rounds, bets, wallet debits/credits and settlements run
 * entirely through the existing global casino system
 * (`CasinoLoopService` → `CasinoService` → `CasinoRepository`), untouched.
 * The window only (a) enforces "one active game per room" against board games
 * via `roomActiveGameLockKey` + `GamesRepository.findActiveSessionForRoom`, and
 * (b) scopes WHO may act:
 *   - start/close: room owner only (`AudioRoomGameAuthzService.assertCanStartCasinoWindow`).
 *   - bet: the window's HOST only — room members are spectators and cannot bet.
 *   - watch: active room members only (`assertCanWatch`); members of other
 *     rooms get NOT_ROOM_MEMBER and can never see the window's status or feed.
 *
 * Spectators receive authoritative real-time state through the room-scoped
 * mirror (`RoomCasinoWindowListener`), which re-emits every global casino
 * broadcast into the window's `/games` session room — same event names and
 * payloads as the global table, no new round/state machinery.
 */
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  CasinoGame,
  GameCategory,
  GameCode,
  GameCurrency,
  GameMode,
  GameSession,
  GameSessionStatus,
} from '@prisma/client';
import { randomInt } from 'node:crypto';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { LockService } from 'src/infra/redis/lock.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { AUDIO_ROOM_NAMESPACE } from 'src/modules/audio-rooms/constants/audio-room.constants';
import {
  AUDIO_ROOMS_SERVICE,
  type IAudioRoomsService,
} from 'src/modules/audio-rooms/interfaces/audio-rooms.service.interface';
import {
  GAME_JOIN_CODE_ALPHABET,
  GAME_JOIN_CODE_LENGTH,
  GAME_SOCKET_EVENTS,
  GAMES_NAMESPACE,
  roomActiveGameLockKey,
} from 'src/modules/games/constants/games.constants';
import { GamesRepository } from 'src/modules/games/repositories/games.repository';
import { AudioRoomGameAuthzService } from 'src/modules/games/services/audio-room-game-authz.service';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { PlaceRoomBetDto } from '../dto/casino-window.dto';
import { CasinoRepository } from '../repositories/casino.repository';
import { CasinoLoopService } from './casino-loop.service';
import { CasinoError, CasinoService } from './casino.service';

/** The two house-banked casino codes a window may carry. */
const CASINO_WINDOW_CODES: ReadonlySet<GameCode> = new Set([
  GameCode.GREEDY_FOOD,
  GameCode.LUCKY_FRUIT,
]);

@Injectable()
export class RoomCasinoWindowService {
  private readonly logger = new Logger(RoomCasinoWindowService.name);

  constructor(
    private readonly authz: AudioRoomGameAuthzService,
    @Inject(AUDIO_ROOMS_SERVICE) private readonly rooms: IAudioRoomsService,
    private readonly games: GamesRepository,
    private readonly repo: CasinoRepository,
    private readonly casino: CasinoService,
    private readonly loop: CasinoLoopService,
    private readonly locks: LockService,
    private readonly sockets: SocketManager,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
  ) {}

  /**
   * Opens a casino window for `game` in `roomId` — room owner only + room live
   * (see `assertCanStartCasinoWindow`), then "one active game per room" under
   * the room lock (fresh read, so a board game or another window created
   * between the check and here still blocks). Creates the `GameSession` marker.
   */
  async startWindow(roomId: string, actorId: string, game: CasinoGame): Promise<unknown> {
    await this.authz.assertCanStartCasinoWindow(roomId, actorId);
    const def = await this.games.getDefinitionByCode(game as unknown as GameCode);
    if (!def) {
      throw new BusinessException(
        ERROR_CODES.GAME_NOT_FOUND,
        'Game not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const session = await this.locks.withLock(roomActiveGameLockKey(roomId), async () => {
      if (await this.games.findActiveSessionForRoom(roomId)) {
        throw new BusinessException(
          ERROR_CODES.GAME_ROOM_ALREADY_ACTIVE,
          'This room already has an active game.',
          HttpStatus.CONFLICT,
        );
      }
      return this.games.createSession({
        definitionId: def.id,
        code: game as unknown as GameCode,
        lobbyId: null,
        joinCode: this.generateJoinCode(),
        hostId: actorId,
        roomId,
        category: GameCategory.PREMIUM,
        currency: GameCurrency.GOLD,
        stake: 0n,
        playerCount: 0,
        mode: GameMode.CLASSIC,
        status: GameSessionStatus.ACTIVE,
        createdBy: actorId,
      });
    });
    this.announceRoomGameChanged(roomId, session.id);
    return this.windowView(session);
  }

  /**
   * Nudges the audio room that its game situation changed, on the ROOM's own
   * channel — the one channel every member is already subscribed to.
   *
   * A casino window has no "opened" push of its own, so a spectator learned a
   * table had started only when their 10s snapshot poll next fired: the host
   * began playing and the watchers saw nothing for up to ten seconds. The
   * close path has [announceClosed] for the same reason in reverse.
   *
   * Carries no state deliberately — clients re-read the membership-gated
   * snapshot, just immediately rather than on the next tick. Best-effort: the
   * poll remains the backstop, so a socket failure must never fail the open.
   */
  private announceRoomGameChanged(roomId: string, sessionId: string): void {
    try {
      this.sockets.emitToNamespaceRoom(
        AUDIO_ROOM_NAMESPACE,
        roomId,
        GAME_SOCKET_EVENTS.ROOM_GAME_CHANGED,
        { roomId, sessionId },
      );
    } catch (err) {
      this.logger.warn(
        `Failed to announce casino window open for room ${roomId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Closes the room's active casino window (marks the `GameSession` COMPLETED —
   * a window carries no stake, so there is nothing to refund). When
   * `actorId` is null (the room-ended path, see `RoomCasinoWindowListener`)
   * the owner check is skipped; otherwise only the room owner may close it —
   * intentionally allowed even if the room has since ended, so a host can
   * always clean up a window the end-listener hasn't reached yet.
   */
  async closeWindow(roomId: string, actorId: string | null): Promise<{ ok: true }> {
    if (actorId !== null) {
      const ownerId = await this.rooms.getOwnerId(roomId);
      if (!ownerId || ownerId !== actorId) {
        throw new BusinessException(
          ERROR_CODES.NOT_ROOM_OWNER,
          'Only the room owner can close this game.',
          HttpStatus.FORBIDDEN,
        );
      }
    }
    const session = await this.requireWindow(roomId);
    await this.games.completeSession(session.id, actorId);
    this.announceClosed(session, 'closed');
    return { ok: true };
  }

  /**
   * Tells every spectator watching [session] to tear the window down, on the
   * SAME channel they receive the round feed on (the window's `/games` session
   * room, which is exactly the set of sockets that can be showing this table).
   *
   * Every teardown path funnels through here — the owner's explicit close, the
   * host leaving the room, room end/delete, and the orphan sweep — because a
   * spectator's window has no state machine of its own: it renders the mirror
   * feed, and the feed simply STOPS when the table dies. Silence is
   * indistinguishable from a quiet round, so without this frame the only thing
   * that ever retracted the view was the client's own periodic snapshot poll.
   *
   * Best-effort by design: the window is already COMPLETED in the database
   * before this runs, so the client's poll and its room-membership checks
   * remain the backstop. A socket failure must never make a close fail.
   */
  private announceClosed(
    session: GameSession,
    reason: 'closed' | 'host_left' | 'room_ended',
  ): void {
    try {
      this.sockets.emitToNamespaceRoom(
        GAMES_NAMESPACE,
        session.id,
        GAME_SOCKET_EVENTS.CASINO_WINDOW_CLOSED,
        {
          sessionId: session.id,
          roomId: session.roomId,
          game: session.code,
          reason,
        },
      );
    } catch (err) {
      this.logger.warn(
        `Failed to announce casino window ${session.id} close: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Closes the room's active casino window when its HOST leaves the audio room.
   *
   * The window is the host's table — they are its only bettor — so once they
   * are gone there is nobody it can belong to and nothing left to watch. It
   * used to survive them: the only lifecycle hooks were room END/DELETE and an
   * orphan sweep that checks whether the ROOM is still live, and a room whose
   * host merely walked out is still perfectly live. So the session stayed
   * ACTIVE indefinitely and every spectator kept rendering a table nobody was
   * playing — the reported "host exited but my game live never closed".
   *
   * Scoped deliberately narrowly: a non-host leaving is ignored, and so is a
   * leave in a room whose active game is a board game. Ownership transfer is
   * handled by [onOwnerChanged] instead, which re-points the window rather
   * than closing it, so a room that hands off cleanly keeps its table.
   */
  async onHostLeft(roomId: string, userId: string): Promise<void> {
    const session = await this.findActiveWindow(roomId);
    if (!session || session.hostId !== userId) return;
    try {
      await this.games.completeSession(session.id, null);
      this.announceClosed(session, 'host_left');
      this.logger.log(
        `Closed casino window ${session.id} (room ${roomId}) — host ${userId} left the room`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to close casino window ${session.id} on host leave: ${(err as Error).message}`,
      );
    }
  }

  /**
   * The host's bet through the room's casino embed — HOST ONLY (a spectator
   * who is not the window's host is rejected server-side, regardless of what
   * their client shows). Delegates the actual validation/debit/persist to the
   * existing `CasinoService.placeBet` verbatim: the same round/phase/chip/item
   * checks, the same idempotent GOLD debit keyed on the caller's `clientBetId`
   * (repeat taps stack, retries dedupe), the same `CasinoBet` rows — so the
   * host's bets land on the SAME global round the room mirror broadcasts.
   * `CasinoError` (incl. insufficient balance) is mapped to a structured HTTP
   * `CASINO_BET_INVALID` with the old app's exact message text.
   */
  async placeHostBet(
    roomId: string,
    actorId: string,
    dto: PlaceRoomBetDto,
  ): Promise<{ balanceAfter: number; betId: string; roundId: string }> {
    const window = await this.requireWindowForGame(roomId, dto.game);
    if (window.hostId !== actorId) {
      throw new BusinessException(
        ERROR_CODES.GAME_NOT_AUTHORIZED,
        'Only the room host can place bets here.',
        HttpStatus.FORBIDDEN,
      );
    }
    const state = this.loop.getState(dto.game);
    try {
      const result = await this.casino.placeBet({
        userId: actorId,
        game: dto.game,
        roundId: dto.roundId,
        item: dto.item ?? dto.symbol ?? '',
        amount: dto.amount,
        activeRoundId: state?.roundId ?? null,
        phase: state?.phase ?? 'betting',
        clientBetId: dto.clientBetId,
      });
      return { balanceAfter: result.balanceAfter, betId: result.betId, roundId: dto.roundId };
    } catch (err) {
      if (err instanceof CasinoError) {
        throw new BusinessException(
          ERROR_CODES.CASINO_BET_INVALID,
          err.message,
          HttpStatus.BAD_REQUEST,
        );
      }
      throw err;
    }
  }

  /**
   * Full sync snapshot for a joining spectator (room member only — the one
   * gate that would otherwise let a non-member probe a private room's window).
   * Built from the same authoritative sources the global `*_sync` uses: the
   * loop's live round state + a fresh DB pool + the host's own bets + the
   * host's GOLD balance, so a spectator joining mid-round sees exactly what
   * the host sees before the tick mirror takes over.
   */
  async getWindow(roomId: string, actorId: string): Promise<unknown> {
    await this.authz.assertCanWatch(roomId, actorId);
    const session = await this.findActiveWindow(roomId);
    if (!session) {
      return null;
    }
    const game = session.code as unknown as CasinoGame;
    const state = this.loop.getState(game);
    const roundId = state?.roundId ?? null;
    const [hostBets, placed, balances] = await Promise.all([
      roundId ? this.repo.listUserBets(roundId, session.hostId) : Promise.resolve([]),
      roundId ? this.repo.listPlacedBets(roundId) : Promise.resolve([]),
      this.wallet.getBalance(session.hostId),
    ]);
    const pool: Record<string, number> = {};
    for (const bet of placed) {
      pool[bet.betItem] = (pool[bet.betItem] ?? 0) + Number(bet.betAmount);
    }
    return {
      window: this.windowView(session),
      roundId,
      roundNumber: state?.roundNumber ?? null,
      phase: state?.phase ?? 'betting',
      secondsRemaining: state?.secondsRemaining ?? 0,
      winningOutcome: state?.winningOutcome ?? null,
      history: state?.history ?? [],
      winners: state?.lastWinners ?? [],
      pool,
      hostBets: hostBets.map((b) => ({ item: b.betItem, amount: Number(b.betAmount) })),
      hostBalance: balances.gold,
    };
  }

  /**
   * Re-points the room's active casino window to a new host after an audio-room
   * OWNERSHIP_TRANSFERRED — the new owner becomes the room's bettor. A no-op
   * when the room has no active window (board game running, or none at all).
   */
  async onOwnerChanged(roomId: string, newOwnerId: string): Promise<void> {
    const session = await this.games.findActiveSessionForRoom(roomId);
    if (!session || !CASINO_WINDOW_CODES.has(session.code)) return;
    if (session.hostId === newOwnerId) return;
    await this.games.updateSessionHost(session.id, newOwnerId);
    this.logger.log(
      `Re-pointed active casino window ${session.id} (room ${roomId}) host to new owner ${newOwnerId}`,
    );
  }

  /**
   * Orphan-window safety net: closes every ACTIVE casino window whose audio
   * room has ended (a room-ended event dropped, an uncaught error before
   * reaching us, or a crash between window-create and room-end). A window
   * carries no refund logic, so we only need to mark it COMPLETED. Invoked
   * on bootstrap. Returns how many windows were closed; a window that raced to
   * close concurrently is handled gracefully.
   */
  async sweepOrphanWindows(): Promise<number> {
    const windows = await this.games.listActiveRoomWindows();
    let closed = 0;
    for (const window of windows) {
      if (!window.roomId) continue;
      if (await this.rooms.isRoomLive(window.roomId)) continue;
      try {
        await this.closeWindow(window.roomId, null);
        closed++;
      } catch (err) {
        this.logger.warn(
          `Orphan casino window ${window.id} (room ${window.roomId}) sweep failed: ${(err as Error).message}`,
        );
      }
    }
    return closed;
  }

  /** The room's current active casino window, or null when none / a board game is running. */
  private async findActiveWindow(roomId: string): Promise<GameSession | null> {
    const session = await this.games.findActiveSessionForRoom(roomId);
    if (!session || !CASINO_WINDOW_CODES.has(session.code)) {
      return null;
    }
    return session;
  }

  /** The room's current active casino window, or NOT_FOUND when none / a board game is running. */
  private async requireWindow(roomId: string): Promise<GameSession> {
    const session = await this.findActiveWindow(roomId);
    if (!session) {
      throw new BusinessException(
        ERROR_CODES.GAME_SESSION_NOT_FOUND,
        'No Gold Coin game is running in this room.',
        HttpStatus.NOT_FOUND,
      );
    }
    return session;
  }

  /** The room's current active window whose code matches `game`, or NOT_FOUND. */
  private async requireWindowForGame(roomId: string, game: CasinoGame): Promise<GameSession> {
    const session = await this.games.findActiveSessionForRoom(roomId);
    if (
      !session ||
      session.status !== GameSessionStatus.ACTIVE ||
      session.code !== (game as unknown as GameCode)
    ) {
      throw new BusinessException(
        ERROR_CODES.GAME_SESSION_NOT_FOUND,
        'No Gold Coin game is running in this room.',
        HttpStatus.NOT_FOUND,
      );
    }
    return session;
  }

  /** A window's joinCode is presentational only (never joinable by code like a lobby). */
  private generateJoinCode(): string {
    let code = '';
    for (let i = 0; i < GAME_JOIN_CODE_LENGTH; i++) {
      code += GAME_JOIN_CODE_ALPHABET[randomInt(GAME_JOIN_CODE_ALPHABET.length)];
    }
    return code;
  }

  private windowView(session: GameSession): {
    sessionId: string;
    game: GameCode;
    roomId: string | null;
    hostId: string;
    status: GameSessionStatus;
    startedAt: Date;
  } {
    return {
      sessionId: session.id,
      game: session.code,
      roomId: session.roomId,
      hostId: session.hostId,
      status: session.status,
      startedAt: session.startedAt,
    };
  }
}
