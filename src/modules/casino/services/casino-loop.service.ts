/**
 * The 24/7 round loop, one per house-banked casino game (Greedy Food, Lucky
 * Fruit) — betting(30s) → spinning(10s) → results(5s), repeating forever.
 * Guarded by a single Redis leader lock so exactly one process instance
 * drives + broadcasts phase transitions at a time (see docs/superpowers/specs/
 * 2026-07-16-greedy-food-lucky-fruit-casino-design.md §5.3 "Timing & phases",
 * §5.4 "Leader-lock scheduler", §10 "Leader-lock correctness" watch-item).
 *
 * Source of truth for tick cadence/payloads/event ordering (reproduced
 * verbatim, event names and payload shapes unified where the two old files
 * agreed and kept DIVERGENT where they didn't — see the per-transition
 * comments below):
 *   - old backend: controller/socket_controllers/greedy_food_socket.js
 *     (`initGreedyFoodLoop`, `startNewRound`, `lockRoundAndSpin`, `settleRoundAndDisplay`)
 *   - old backend: controller/socket_controllers/lucky_fruit_socket.js
 *     (`initLuckyFruitLoop`, `_createNewRound`, `selectWinningOutcome`/`settleRound`, `_buildSyncPayload`)
 *
 * PHASE-TICK SEMANTICS (unified across both games — see the design note in
 * this file's test suite): each 1-second tick DECREMENTS `secondsRemaining`,
 * ALWAYS broadcasts the regular `*_tick`, and THEN — if that decrement just
 * reached 0 — performs the phase transition (which resets the timer for the
 * new phase and broadcasts its own event) in the SAME call. This matches the
 * old Lucky Fruit file's literal structure (decrement → tick → maybe
 * transition, all in one iteration); the old Greedy file instead checks
 * `roundTimer > 0` BEFORE decrementing, which needs one extra "wasted" tick
 * to notice zero and transition — an incidental legacy quirk, not a decision
 * worth preserving, since unifying both games onto one shared phase machine
 * is the entire point of this service.
 *
 * DOES NOT re-select a winning outcome at settle time — that's chosen once,
 * here, at the betting→spinning transition (via the pure engine selectors)
 * and handed to `CasinoService.settleRound` already fixed; see that class's
 * own doc comment for why re-selecting there would be wrong.
 */
import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { CasinoGame } from '@prisma/client';
import { LockService } from 'src/infra/redis/lock.service';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import {
  CASINO_EVENTS,
  CASINO_ROOMS,
  HISTORY_LEN,
  PHASE_SECONDS,
} from '../constants/casino.constants';
import { selectGreedyOutcome } from '../engines/greedy-food.engine';
import { selectLuckyOutcome } from '../engines/lucky-fruit.engine';
import {
  CASINO_BROADCASTER,
  type CasinoBroadcaster,
} from '../interfaces/casino-broadcaster.interface';
import { CasinoRepository } from '../repositories/casino.repository';
import {
  freshRoundState,
  pushHistory,
  type CasinoRoundState,
  type CasinoRoundWinnerView,
} from './casino-round.state';
import { CasinoService } from './casino.service';

/** The two house-banked games this loop drives — one persistent round-cycle each. */
export const CASINO_GAMES: readonly CasinoGame[] = [CasinoGame.GREEDY_FOOD, CasinoGame.LUCKY_FRUIT];

/** Shared leader lock — one process drives BOTH games' loops at a time (spec §5.4). */
const LEADER_LOCK_KEY = 'casino:loop:leader';
/** Comfortably longer than the 1s tick so a brief stall doesn't cause a false failover. */
const LEADER_LOCK_TTL_MS = 3_000;
const TICK_INTERVAL_MS = 1_000;

@Injectable()
export class CasinoLoopService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CasinoLoopService.name);

  private readonly states = new Map<CasinoGame, CasinoRoundState>();
  private readonly gameTimers = new Map<CasinoGame, NodeJS.Timeout>();

  private isLeader = false;
  private leaderToken: string | null = null;
  private release: (() => Promise<void>) | null = null;
  /** Coalesces same-tick leadership checks from both games' timers into one Redis round trip. */
  private leadershipCheck: Promise<boolean> | null = null;

  constructor(
    private readonly repo: CasinoRepository,
    private readonly casino: CasinoService,
    private readonly locks: LockService,
    // CASINO_BROADCASTER is useExisting-aliased to CasinoGateway (casino.module.ts),
    // which itself depends on this loop (for `getState`) — a real DI cycle. Both
    // edges must be forwardRef'd (see the matching @Inject in CasinoGateway).
    @Inject(forwardRef(() => CASINO_BROADCASTER))
    private readonly broadcaster: CasinoBroadcaster,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
  ) {}

  onModuleInit(): void {
    for (const game of CASINO_GAMES) {
      // Eagerly try to seed the first round (mirrors the old apps' `await
      // startNewRound()`/`_createNewRound()` before their interval starts) —
      // a no-op if this instance isn't the leader.
      void this.bootGame(game).catch((err: Error) =>
        this.logger.error(`Casino bootGame(${game}) failed: ${err.message}`),
      );
      const timer = setInterval(() => void this.tickGame(game), TICK_INTERVAL_MS);
      timer.unref();
      this.gameTimers.set(game, timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const timer of this.gameTimers.values()) clearInterval(timer);
    this.gameTimers.clear();
    if (this.release) {
      const release = this.release;
      this.release = null;
      this.leaderToken = null;
      this.isLeader = false;
      try {
        await release();
      } catch (err) {
        this.logger.warn(
          `Failed to release casino leader lock on shutdown: ${(err as Error).message}`,
        );
      }
    }
  }

  // ======================= Leader lock =======================

  /**
   * `true` iff this instance currently holds `casino:loop:leader`. If already
   * held, RENEWS it (release-then-immediately-reacquire — `LockService` has
   * no compare-and-extend primitive, only SET-NX acquire + safe-delete
   * release, so a fresh renewal-with-ownership-check has to go through
   * acquire again). If not held, attempts a normal acquire. Concurrent calls
   * within the same tick (both games' timers can fire the same second)
   * coalesce onto one in-flight check instead of racing each other.
   */
  private async ensureLeadership(): Promise<boolean> {
    if (!this.leadershipCheck) {
      this.leadershipCheck = this.renewOrAcquireLeadership().finally(() => {
        this.leadershipCheck = null;
      });
    }
    return this.leadershipCheck;
  }

  private async renewOrAcquireLeadership(): Promise<boolean> {
    if (this.isLeader && this.leaderToken) {
      try {
        const extended = await this.locks.extend(LEADER_LOCK_KEY, this.leaderToken, LEADER_LOCK_TTL_MS);
        if (extended) {
          return true;
        }
        this.logger.warn('Casino leader lock extension failed. Attempting re-acquisition.');
      } catch (err) {
        this.logger.warn(`Casino leader-lock extend failed: ${(err as Error).message}`);
      }
      this.isLeader = false;
      this.leaderToken = null;
      this.release = null;
    }

    try {
      const lock = await this.locks.acquireLockObject(LEADER_LOCK_KEY, LEADER_LOCK_TTL_MS);
      if (lock) {
        this.release = lock.release;
        this.leaderToken = lock.token;
        this.isLeader = true;
      }
    } catch (err) {
      this.logger.warn(`Casino leader-lock acquire failed: ${(err as Error).message}`);
    }
    return this.isLeader;
  }

  // ======================= Boot =======================

  /**
   * (Re-)initializes `game`'s round state with a brand-new `BETTING` round —
   * a no-op if this instance isn't the leader. Called once at startup per
   * game (`onModuleInit`) and again by `tickGame` the first time a NEWLY-led
   * instance sees no cached state for `game` (a failover pickup). In the
   * failover case any bets left on an abandoned prior round are NOT
   * recovered here — see the Task 10 report's "concerns" section.
   */
  async bootGame(game: CasinoGame): Promise<void> {
    const leader = await this.ensureLeadership();
    if (!leader) return;
    await this.bootWithoutLeaderCheck(game);
  }

  private async bootWithoutLeaderCheck(game: CasinoGame): Promise<void> {
    const state = await this.createFreshRoundState(game);
    this.states.set(game, state);
    if (game === CasinoGame.GREEDY_FOOD) {
      // Old Greedy's `startNewRound` fires `greedy_food_new_round` both at
      // cold start and at the periodic results→betting reset — same function.
      this.broadcastNewRound(game, state);
    }
    // Lucky Fruit's cold-start `_createNewRound()` does NOT broadcast — its
    // periodic reset broadcasts `lucky_fruit_sync` separately (see
    // `transitionResultsToBetting`); a joining client gets its own
    // `lucky_fruit_sync` reply from the (Task 11) gateway instead.
  }

  private async createFreshRoundState(game: CasinoGame): Promise<CasinoRoundState> {
    const carryOver = this.states.get(game);
    const round = await this.repo.createRound(game);
    return freshRoundState(
      round.id,
      round.roundNumber,
      carryOver ? { history: carryOver.history, lastWinners: carryOver.lastWinners } : undefined,
    );
  }

  // ======================= Tick =======================

  /**
   * One 1-second tick for `game` — a full no-op if this instance isn't the
   * current leader (the crux correctness guarantee: only the leader ever
   * advances phases, calls `settleRound`, or broadcasts). See the class doc
   * comment for the unified decrement→tick→maybe-transition ordering.
   */
  async tickGame(game: CasinoGame): Promise<void> {
    try {
      const leader = await this.ensureLeadership();
      if (!leader) return;

      if (!this.states.has(game)) {
        await this.bootWithoutLeaderCheck(game);
        return;
      }

      const state = this.states.get(game)!;
      state.poolBets = await this.computePoolBets(state.roundId!);
      state.secondsRemaining -= 1;
      this.broadcastTick(game, state);

      if (state.secondsRemaining <= 0) {
        await this.transition(game, state);
      }
    } catch (err) {
      this.logger.error(`Casino loop tick failed for ${game}: ${(err as Error).message}`);
    }
  }

  private async transition(game: CasinoGame, state: CasinoRoundState): Promise<void> {
    if (state.phase === 'betting') {
      await this.transitionBettingToSpinning(game, state);
    } else if (state.phase === 'spinning') {
      await this.transitionSpinningToResults(game, state);
    } else {
      await this.transitionResultsToBetting(game);
    }
  }

  /**
   * Locks in the winning outcome. Flips `state.phase` to `'spinning'`
   * SYNCHRONOUSLY before the first `await` — the gateway's bet-placement
   * check reads `getState(game).phase` and must never see `'betting'` again
   * once this transition has started, so the DB read just below is
   * guaranteed to be "the bets snapshot taken at lock time" (spec §5.4).
   */
  private async transitionBettingToSpinning(
    game: CasinoGame,
    state: CasinoRoundState,
  ): Promise<void> {
    const roundId = state.roundId!;
    state.phase = 'spinning';
    state.secondsRemaining = PHASE_SECONDS.spinning;

    const placed = await this.repo.listPlacedBets(roundId);
    const bets = placed.map((b) => ({ item: b.betItem, amount: Number(b.betAmount) }));
    const outcome =
      game === CasinoGame.GREEDY_FOOD ? selectGreedyOutcome(bets) : selectLuckyOutcome(bets);
    state.winningOutcome = outcome;

    if (game === CasinoGame.GREEDY_FOOD) {
      // Old Greedy's `greedy_food_spin` carries no roundId.
      this.broadcast(game, CASINO_EVENTS.GREEDY.SPIN, {
        winningOutcome: outcome,
        secondsRemaining: state.secondsRemaining,
      });
    } else {
      // Old Lucky's `lucky_fruit_result` DOES carry roundId.
      this.broadcast(game, CASINO_EVENTS.LUCKY.RESULT, {
        roundId,
        winningOutcome: outcome,
        secondsRemaining: state.secondsRemaining,
      });
    }
  }

  /** Settles the round against the outcome fixed at the spinning transition, then displays results. */
  private async transitionSpinningToResults(
    game: CasinoGame,
    state: CasinoRoundState,
  ): Promise<void> {
    const roundId = state.roundId!;
    const outcome = state.winningOutcome!;
    state.phase = 'results';
    state.secondsRemaining = PHASE_SECONDS.results;

    const result = await this.casino.settleRound(game, roundId, outcome);
    state.history = pushHistory(state.history, result.winningOutcome, HISTORY_LEN);
    state.lastWinners = await this.resolveWinnerViews(result.winners);

    if (game === CasinoGame.GREEDY_FOOD) {
      this.broadcast(game, CASINO_EVENTS.GREEDY.RESULTS, {
        winningOutcome: result.winningOutcome,
        winners: state.lastWinners,
        payouts: result.payouts,
        secondsRemaining: state.secondsRemaining,
      });
    } else {
      this.broadcast(game, CASINO_EVENTS.LUCKY.SETTLEMENT, {
        roundId,
        winningOutcome: result.winningOutcome,
        winners: state.lastWinners,
        payouts: result.payouts,
        secondsRemaining: state.secondsRemaining,
      });
    }
  }

  /** Starts a brand-new round; carries `history`/`lastWinners` forward (they're rolling, not per-round). */
  private async transitionResultsToBetting(game: CasinoGame): Promise<void> {
    const state = await this.createFreshRoundState(game);
    this.states.set(game, state);
    if (game === CasinoGame.GREEDY_FOOD) {
      this.broadcastNewRound(game, state);
    } else {
      this.broadcastLuckySync(game, state);
    }
  }

  // ======================= Broadcast helpers =======================

  private broadcastTick(game: CasinoGame, state: CasinoRoundState): void {
    const onlineCount = this.broadcaster.onlineCount(this.roomFor(game));
    if (game === CasinoGame.GREEDY_FOOD) {
      this.broadcast(game, CASINO_EVENTS.GREEDY.TICK, {
        roundId: state.roundId,
        roundNumber: state.roundNumber,
        phase: state.phase,
        secondsRemaining: state.secondsRemaining,
        poolBets: state.poolBets,
        onlineCount,
      });
    } else {
      this.broadcast(game, CASINO_EVENTS.LUCKY.TICK, {
        roundId: state.roundId,
        roundNumber: state.roundNumber,
        phase: state.phase,
        secondsRemaining: state.secondsRemaining,
        onlineCount,
        pool: state.poolBets,
      });
    }
  }

  private broadcastNewRound(game: CasinoGame, state: CasinoRoundState): void {
    this.broadcast(game, CASINO_EVENTS.GREEDY.NEW_ROUND, {
      roundId: state.roundId,
      roundNumber: state.roundNumber,
      secondsRemaining: state.secondsRemaining,
    });
  }

  /**
   * Lucky Fruit's periodic "new round" announcement — the OLD app's full
   * `_buildSyncPayload` shape, minus `recentWinners` (a bespoke "last 10
   * wins" DB query with no `CasinoRepository` equivalent yet — see the Task
   * 10 report's concerns).
   */
  private broadcastLuckySync(game: CasinoGame, state: CasinoRoundState): void {
    this.broadcast(game, CASINO_EVENTS.LUCKY.SYNC, {
      roundId: state.roundId,
      roundNumber: state.roundNumber,
      phase: state.phase,
      secondsRemaining: state.secondsRemaining,
      onlineCount: this.broadcaster.onlineCount(this.roomFor(game)),
      pool: state.poolBets,
      history: state.history,
      winners: state.lastWinners,
    });
  }

  private broadcast(game: CasinoGame, event: string, payload: unknown): void {
    this.broadcaster.emitToRoom(this.roomFor(game), event, payload);
  }

  private roomFor(game: CasinoGame): string {
    return game === CasinoGame.GREEDY_FOOD ? CASINO_ROOMS.GREEDY_FOOD : CASINO_ROOMS.LUCKY_FRUIT;
  }

  // ======================= Pool + sync =======================

  private async computePoolBets(roundId: string): Promise<Record<string, number>> {
    const placed = await this.repo.listPlacedBets(roundId);
    const pool: Record<string, number> = {};
    for (const bet of placed) {
      pool[bet.betItem] = (pool[bet.betItem] ?? 0) + Number(bet.betAmount);
    }
    return pool;
  }

  private async resolveWinnerViews(
    winners: Array<{ userId: string; amount: number }>,
  ): Promise<CasinoRoundWinnerView[]> {
    if (winners.length === 0) return [];
    const identities = await this.profiles.resolvePublicIdentities(winners.map((w) => w.userId));
    return winners.map((w) => ({
      username: identities.get(w.userId)?.displayName ?? `Player_${w.userId}`,
      amount: w.amount,
      avatarUrl: identities.get(w.userId)?.avatarUrl ?? null,
    }));
  }

  /**
   * Current in-memory round state for `game` (a shallow copy — safe for the
   * (Task 11) gateway to spread straight into a `*_sync` reply). `undefined`
   * only before this game's first round has ever been created on THIS
   * instance (e.g. briefly at startup before leadership is won, or on an
   * instance that has never held leadership for this game).
   */
  getState(game: CasinoGame): CasinoRoundState | undefined {
    const state = this.states.get(game);
    if (!state) return undefined;
    return {
      ...state,
      poolBets: { ...state.poolBets },
      history: [...state.history],
      lastWinners: [...state.lastWinners],
    };
  }
}
