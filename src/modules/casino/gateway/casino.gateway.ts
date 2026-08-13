/**
 * Inbound `/casino` WebSocket gateway — the client-facing half of the
 * house-banked casino games (Greedy Food, Lucky Fruit). Handles the four
 * client→server events per game (join/bet/history/leave) and IMPLEMENTS the
 * `CasinoBroadcaster` seam `CasinoLoopService` depends on (the 24/7 round
 * loop calls back through this gateway to broadcast ticks/spins/results —
 * see `interfaces/casino-broadcaster.interface.ts`).
 *
 * Source of truth for event names + payload shapes (reproduced verbatim):
 *   - old backend: controller/socket_controllers/greedy_food_socket.js
 *     (`greedyFoodSocketHandlers`: `join_greedy_food`, `place_casino_bet`,
 *     `get_greedy_food_win_history`, `leave_greedy_food`)
 *   - old backend: controller/socket_controllers/lucky_fruit_socket.js
 *     (`handleLuckyFruitSocket`: `join_lucky_fruit`, `place_lucky_fruit_bet`,
 *     `get_lucky_fruit_win_history`, `leave_lucky_fruit`)
 * See also docs/superpowers/specs/2026-07-16-greedy-food-lucky-fruit-casino-design.md §5.7.
 *
 * Deliberately does NOT re-validate business rules already owned by
 * `CasinoService.placeBet` (chip whitelist, item/symbol bettable, ≤6-distinct
 * Lucky cap, phase/round match) — this gateway only shapes the wire payload,
 * normalizes Greedy's `item` / Lucky's `symbol` into one field, and converts
 * any thrown `CasinoError` into the shared `casino_error { message }` event.
 */
import { forwardRef, Inject } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { CasinoGame } from '@prisma/client';
import type { Server, Socket } from 'socket.io';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { BaseGateway } from 'src/infra/socket/base.gateway';
import { SocketManager } from 'src/infra/socket/socket.manager';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import {
  CASINO_EVENTS,
  CASINO_NAMESPACE,
  CASINO_ROOMS,
  GREEDY_ITEMS,
  LUCKY_OUTCOMES,
  RECENT_WINNERS_LIMIT,
} from '../constants/casino.constants';
import type { CasinoBroadcaster } from '../interfaces/casino-broadcaster.interface';
import { CasinoRepository } from '../repositories/casino.repository';
import { CasinoLoopService } from '../services/casino-loop.service';
import { CasinoError, CasinoService } from '../services/casino.service';
import { PlaceCasinoBetDto } from '../dto/casino.dto';

/** A normalized, validated bet payload — see `CasinoGateway.validateBetPayload`. */
interface ValidatedBet {
  roundId: string;
  item: string;
  amount: number;
  clientBetId: string;
}

@WebSocketGateway({ namespace: CASINO_NAMESPACE })
export class CasinoGateway extends BaseGateway implements CasinoBroadcaster {
  @WebSocketServer() protected readonly server!: Server;

  constructor(
    manager: SocketManager,
    private readonly casino: CasinoService,
    // `CasinoLoopService` depends back on this gateway (via the CASINO_BROADCASTER
    // token, useExisting-aliased to CasinoGateway — see casino.module.ts), so this
    // edge of the cycle must be forwardRef'd or Nest cannot construct either.
    @Inject(forwardRef(() => CasinoLoopService)) private readonly loop: CasinoLoopService,
    private readonly repo: CasinoRepository,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
  ) {
    super(manager);
  }

  override async handleDisconnect(client: Socket): Promise<void> {
    const isGreedy = client.rooms?.has(CASINO_ROOMS.GREEDY_FOOD);
    const isLucky = client.rooms?.has(CASINO_ROOMS.LUCKY_FRUIT);

    await super.handleDisconnect(client);

    if (isGreedy) {
      this.broadcastOnlineCount(CasinoGame.GREEDY_FOOD);
    }
    if (isLucky) {
      this.broadcastOnlineCount(CasinoGame.LUCKY_FRUIT);
    }
  }

  // ======================= CasinoBroadcaster =======================
  // Public wrappers so `CasinoLoopService` can depend on the small
  // `CasinoBroadcaster` interface rather than this concrete gateway (avoids a
  // gateway↔loop circular/forward module dependency — see the interface's
  // own doc comment). Task 12 binds `{ provide: CASINO_BROADCASTER, useExisting: CasinoGateway }`.

  /** Emit `event` with `payload` to every socket in `room` (Redis-adapter backed). */
  emitToRoom(room: string, event: string, payload: unknown): void {
    super.emitToRoom(room, event, payload);
  }

  /** Number of sockets currently connected to `room` on THIS namespace. */
  onlineCount(room: string): number {
    // For a namespaced gateway Nest assigns the Socket.IO *Namespace* to
    // `@WebSocketServer()`, whose room→socket-set map is `.adapter.rooms`
    // (the root `Server` exposes it one level deeper, as
    // `.sockets.adapter.rooms`). Support both shapes, and tolerate the brief
    // pre-`afterInit` window where the server isn't wired yet — otherwise the
    // 24/7 loop's very first tick throws `Cannot read properties of undefined`.
    const s = this.server as unknown as {
      adapter?: { rooms?: Map<string, Set<string>> };
      sockets?: { adapter?: { rooms?: Map<string, Set<string>> } };
    };
    const rooms = s?.adapter?.rooms ?? s?.sockets?.adapter?.rooms;
    return rooms?.get(room)?.size ?? 0;
  }

  // ======================= Greedy Food =======================

  @SubscribeMessage(CASINO_EVENTS.GREEDY.JOIN)
  async onGreedyJoin(@ConnectedSocket() client: Socket): Promise<void> {
    await this.handleJoin(client, CasinoGame.GREEDY_FOOD);
  }

  @SubscribeMessage(CASINO_EVENTS.GREEDY.LEAVE)
  async onGreedyLeave(@ConnectedSocket() client: Socket): Promise<void> {
    await this.manager.leaveRoom(client, CASINO_ROOMS.GREEDY_FOOD);
    this.broadcastOnlineCount(CasinoGame.GREEDY_FOOD);
  }

  @SubscribeMessage(CASINO_EVENTS.GREEDY.BET)
  async onGreedyBet(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: PlaceCasinoBetDto,
  ): Promise<void> {
    await this.handleBet(client, CasinoGame.GREEDY_FOOD, body);
  }

  @SubscribeMessage(CASINO_EVENTS.GREEDY.HISTORY_REQ)
  async onGreedyHistory(@ConnectedSocket() client: Socket): Promise<void> {
    await this.handleHistory(client, CasinoGame.GREEDY_FOOD);
  }

  // ======================= Lucky Fruit =======================

  @SubscribeMessage(CASINO_EVENTS.LUCKY.JOIN)
  async onLuckyJoin(@ConnectedSocket() client: Socket): Promise<void> {
    await this.handleJoin(client, CasinoGame.LUCKY_FRUIT);
  }

  @SubscribeMessage(CASINO_EVENTS.LUCKY.LEAVE)
  async onLuckyLeave(@ConnectedSocket() client: Socket): Promise<void> {
    await this.manager.leaveRoom(client, CASINO_ROOMS.LUCKY_FRUIT);
    this.broadcastOnlineCount(CasinoGame.LUCKY_FRUIT);
  }

  @SubscribeMessage(CASINO_EVENTS.LUCKY.BET)
  async onLuckyBet(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: PlaceCasinoBetDto,
  ): Promise<void> {
    await this.handleBet(client, CasinoGame.LUCKY_FRUIT, body);
  }

  @SubscribeMessage(CASINO_EVENTS.LUCKY.HISTORY_REQ)
  async onLuckyHistory(@ConnectedSocket() client: Socket): Promise<void> {
    await this.handleHistory(client, CasinoGame.LUCKY_FRUIT);
  }

  // ======================= Shared handler bodies =======================

  /**
   * Join the game's global room and reply with a full `*_sync` snapshot — see
   * the old apps' `join_greedy_food`/`join_lucky_fruit`. Uses `SocketManager`
   * (not the raw socket) so presence stays in sync, exactly like every other
   * gateway's room handling.
   */
  private async handleJoin(client: Socket, game: CasinoGame): Promise<void> {
    const user = client.data.user as AuthenticatedUser;
    await this.manager.joinRoom(client, this.roomFor(game));
    const payload = await this.buildSyncPayload(game, user.id);
    client.emit(this.syncEventFor(game), payload);
    this.broadcastOnlineCount(game);
  }

  private async handleHistory(client: Socket, game: CasinoGame): Promise<void> {
    const user = client.data.user as AuthenticatedUser;
    const history = await this.casino.getWinHistory(user.id, game);
    const event =
      game === CasinoGame.GREEDY_FOOD ? CASINO_EVENTS.GREEDY.HISTORY : CASINO_EVENTS.LUCKY.HISTORY;
    client.emit(event, { history });
  }

  /**
   * Validates + places one bet, threading the client's own `clientBetId`
   * straight through to `CasinoService.placeBet` (never regenerated here —
   * that id is the anchor that makes repeat taps STACK and retries dedupe).
   * On success: acks the sender (`bet_placed_success`/`lucky_fruit_bet_placed`)
   * then broadcasts a fresh pool snapshot to the whole room. On a thrown
   * `CasinoError` (or anything else, defensively): emits the shared
   * `casino_error { message }` to the REQUESTING SOCKET ONLY — see the old
   * apps' identical `socket.emit("casino_error", ...)` failure path.
   */
  private async handleBet(
    client: Socket,
    game: CasinoGame,
    body: PlaceCasinoBetDto,
  ): Promise<void> {
    const user = client.data.user as AuthenticatedUser;
    const isLucky = game === CasinoGame.LUCKY_FRUIT;
    try {
      const { roundId, item, amount, clientBetId } = this.validateBetPayload(body);
      const state = this.loop.getState(game);

      const result = await this.casino.placeBet({
        userId: user.id,
        game,
        roundId,
        item,
        amount,
        activeRoundId: state?.roundId ?? null,
        phase: state?.phase ?? 'betting',
        clientBetId,
      });

      if (isLucky) {
        // Old Lucky's `lucky_fruit_bet_placed` ack carries the roundId back too.
        client.emit(CASINO_EVENTS.LUCKY.BET_OK, {
          symbol: item,
          amount,
          balance: result.balanceAfter,
          roundId,
        });
      } else {
        client.emit(CASINO_EVENTS.GREEDY.BET_OK, { item, amount, balance: result.balanceAfter });
      }

      const poolBets = await this.currentPoolBets(game, state?.roundId ?? roundId);
      if (isLucky) {
        // Old Lucky broadcasts the pool map DIRECTLY (no wrapper object).
        this.emitToRoom(this.roomFor(game), CASINO_EVENTS.LUCKY.POOL, poolBets);
      } else {
        this.emitToRoom(this.roomFor(game), CASINO_EVENTS.GREEDY.POOL, { poolBets });
      }
    } catch (err) {
      const message = err instanceof CasinoError ? err.message : 'Internal transaction failed';
      client.emit(CASINO_EVENTS.ERROR, { message });
    }
  }

  // ======================= Payload validation =======================

  /**
   * Guards against a malformed/incomplete wire payload BEFORE it ever reaches
   * `CasinoService.placeBet` — a missing/wrong-typed field here would
   * otherwise flow into the wallet idempotency key or a Prisma write as
   * `"undefined"`. Business-rule validation (chip whitelist, bettable
   * item/symbol, phase/round match, Lucky's ≤6-distinct cap) stays entirely
   * in `CasinoService`; this only checks shape. Throws `CasinoError` so the
   * caller's single catch-all in `handleBet` handles both kinds of failure
   * identically.
   */
  private validateBetPayload(body: PlaceCasinoBetDto): ValidatedBet {
    const roundId = body?.roundId;
    const item = body?.item ?? body?.symbol;
    const amount = body?.amount;
    const clientBetId = body?.clientBetId;

    if (typeof roundId !== 'string' || roundId.length === 0) {
      throw new CasinoError('A roundId is required to place a bet.');
    }
    if (typeof item !== 'string' || item.length === 0) {
      throw new CasinoError('A bet item/symbol is required.');
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new CasinoError('Invalid chip/bet amount');
    }
    if (typeof clientBetId !== 'string' || clientBetId.length === 0) {
      throw new CasinoError('A clientBetId is required to place a bet.');
    }
    return { roundId, item, amount, clientBetId };
  }

  // ======================= Sync payload =======================

  /**
   * Full `*_sync` snapshot for a just-joined socket — reproduces the old
   * apps' `join_greedy_food`/`join_lucky_fruit` payloads (including BOTH the
   * Greedy-only `activeBets` map/`myProfile` compatibility fields and the
   * cross-game `recentWinners` feed, which both old files send — see the
   * design doc §5.7 and the class doc comment on `buildRecentWinners`).
   * Built from three independent sources: `CasinoLoopService.getState` (round
   * timing/history/last winners), `CasinoRepository` (this user's own
   * still-placed bets + the room's live pool), and the wallet (GOLD balance).
   */
  private async buildSyncPayload(
    game: CasinoGame,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const state = this.loop.getState(game);
    const roundId = state?.roundId ?? null;
    const phase = state?.phase ?? 'betting';
    const secondsRemaining = state?.secondsRemaining ?? 0;
    const winningOutcome = state?.winningOutcome ?? null;
    const history = state?.history ?? [];
    const winners = state?.lastWinners ?? [];

    const [myBets, balances, recentWinners, poolBets] = await Promise.all([
      roundId ? this.repo.listUserBets(roundId, userId) : Promise.resolve([]),
      this.wallet.getBalance(userId),
      this.buildRecentWinners(game),
      roundId ? this.currentPoolBets(game, roundId) : Promise.resolve(this.seedPool(game)),
    ]);
    const onlineCount = this.onlineCount(this.roomFor(game));

    if (game === CasinoGame.GREEDY_FOOD) {
      const myBetsList = myBets.map((b) => ({ item: b.betItem, amount: Number(b.betAmount) }));
      const activeBets: Record<string, number> = {};
      for (const b of myBetsList) {
        activeBets[b.item] = (activeBets[b.item] ?? 0) + b.amount;
      }
      return {
        roundId,
        roundNumber: state?.roundNumber ?? null,
        phase,
        secondsRemaining,
        winningOutcome,
        myBets: myBetsList,
        activeBets,
        poolBets,
        history,
        balance: balances.gold,
        myProfile: { balance: balances.gold },
        winners,
        recentWinners,
        onlineCount,
      };
    }

    return {
      roundId,
      roundNumber: state?.roundNumber ?? null,
      phase,
      secondsRemaining,
      winningOutcome,
      onlineCount,
      pool: poolBets,
      history,
      winners,
      recentWinners,
      balance: balances.gold,
      myBets: myBets.map((b) => ({ symbol: b.betItem, amount: Number(b.betAmount) })),
    };
  }

  /**
   * Cross-user "last N wins" ticker (see the old apps' `getRecentWinners`,
   * present in BOTH `greedy_food_socket.js` and `lucky_fruit_socket.js` — not
   * Lucky-only). Old Greedy formats `"<username> won ₹ <payout>"`; old Lucky
   * formats `"<username> won 🪙 <payout>"` — both reproduced verbatim
   * (including Greedy's literal ₹ glyph despite the currency being GOLD).
   * Username resolution goes through `IProfileService` (this codebase has no
   * `usernames` table joinable from SQL like the old app did), falling back
   * to `Player_<userId>` exactly like the old app's `COALESCE`.
   */
  private async buildRecentWinners(game: CasinoGame): Promise<string[]> {
    const rows = await this.repo.recentWinningBets(game, RECENT_WINNERS_LIMIT);
    if (rows.length === 0) return [];
    const identities = await this.profiles.resolvePublicIdentities(rows.map((r) => r.userId));
    const glyph = game === CasinoGame.GREEDY_FOOD ? '₹' : '🪙';
    return rows.map((r) => {
      const username = identities.get(r.userId)?.displayName ?? `Player_${r.userId}`;
      return `${username} won ${glyph} ${r.payoutAmount}`;
    });
  }

  // ======================= Pool helpers =======================

  /** All of a game's outcomes seeded at 0 — matches the old apps' `getPoolBetsSummary`/`getPoolSummary`. */
  private seedPool(game: CasinoGame): Record<string, number> {
    const keys = game === CasinoGame.GREEDY_FOOD ? GREEDY_ITEMS : LUCKY_OUTCOMES;
    const pool: Record<string, number> = {};
    for (const key of keys) pool[key] = 0;
    return pool;
  }

  /**
   * Live per-item/symbol totals staked in `roundId`, recomputed fresh from
   * `CasinoBet` rows (NOT `CasinoLoopService`'s once-per-tick cache — that can
   * be up to ~1s stale, which would omit the bet just placed on THIS
   * request). Zero-seeded first so every outcome is present even with no
   * bets on it yet, exactly like the old apps' summary helpers.
   */
  private async currentPoolBets(
    game: CasinoGame,
    roundId: string,
  ): Promise<Record<string, number>> {
    const pool = this.seedPool(game);
    const placed = await this.repo.listPlacedBets(roundId);
    for (const bet of placed) {
      pool[bet.betItem] = (pool[bet.betItem] ?? 0) + Number(bet.betAmount);
    }
    return pool;
  }

  private roomFor(game: CasinoGame): string {
    return game === CasinoGame.GREEDY_FOOD ? CASINO_ROOMS.GREEDY_FOOD : CASINO_ROOMS.LUCKY_FRUIT;
  }

  private syncEventFor(game: CasinoGame): string {
    return game === CasinoGame.GREEDY_FOOD ? CASINO_EVENTS.GREEDY.SYNC : CASINO_EVENTS.LUCKY.SYNC;
  }

  private broadcastOnlineCount(game: CasinoGame): void {
    const state = this.loop.getState(game);
    if (!state) return;
    const room = this.roomFor(game);
    const count = this.onlineCount(room);
    const event =
      game === CasinoGame.GREEDY_FOOD ? CASINO_EVENTS.GREEDY.TICK : CASINO_EVENTS.LUCKY.TICK;
    if (game === CasinoGame.GREEDY_FOOD) {
      this.emitToRoom(room, event, {
        roundId: state.roundId,
        roundNumber: state.roundNumber,
        phase: state.phase,
        secondsRemaining: state.secondsRemaining,
        poolBets: state.poolBets,
        onlineCount: count,
      });
    } else {
      this.emitToRoom(room, event, {
        roundId: state.roundId,
        roundNumber: state.roundNumber,
        phase: state.phase,
        secondsRemaining: state.secondsRemaining,
        onlineCount: count,
        pool: state.poolBets,
      });
    }
  }
}
