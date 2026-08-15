/**
 * Casino (house-banked games: Greedy Food, Lucky Fruit) constants.
 *
 * Source of truth for event names, multiplier tables, item/symbol sets,
 * phase durations and chip whitelist is the old Node/Express socket
 * controllers — copied verbatim (no rebalancing, no renaming):
 *   - old backend: controller/socket_controllers/greedy_food_socket.js
 *   - old backend: controller/socket_controllers/lucky_fruit_socket.js
 * See also docs/superpowers/specs/2026-07-16-greedy-food-lucky-fruit-casino-design.md §5.
 *
 * Pure constants only — no DB access, no side effects.
 */

/** Realtime namespace for the casino gateway. */
export const CASINO_NAMESPACE = '/casino';

/** Global lobby room names (one persistent room per game, 24/7 loop). */
export const CASINO_ROOMS = {
  GREEDY_FOOD: 'greedy_food_global',
  LUCKY_FRUIT: 'lucky_fruit_global',
} as const;

/** Per-game round phase durations in seconds (betting → spinning → results). */
export const PHASE_SECONDS = { betting: 30, spinning: 10, results: 5 } as const;
export type CasinoPhase = keyof typeof PHASE_SECONDS;

/** Only these chip denominations may be wagered. */
export const CASINO_CHIPS = [100, 500, 1000, 10000, 50000] as const;

/** Lucky Fruit: max distinct symbols a single user may bet on in one round. */
export const LUCKY_MAX_SYMBOLS = 6;

/**
 * Per-user lock guarding a single bet-placement's debit+persist critical
 * section (defense in depth — the wallet already serialises/guards its own
 * balance mutation on a DIFFERENT key, so this must stay a distinct key or
 * the two locks would deadlock each other). Mirrors the `game*LockKey`
 * helpers in `games.constants.ts`.
 */
export const casinoBetLockKey = (userId: string): string => `casino:lock:bet:${userId}`;

/**
 * Round-level lock serialising bet-placement against settlement for ONE round.
 * `placeBet` takes it (inside the per-user bet lock) to re-check the round's
 * DB state before persisting a bet; `settleRound` takes it for the whole
 * settle critical section (read snapshot → credit/refund). This closes the
 * orphaned-bet race: a bet validated against the in-memory `betting` phase can
 * no longer slip in after settlement has snapshotted the round.
 *
 * Lock ordering is consistent (round lock → per-user bet lock → wallet row
 * lock), so it can never deadlock with the wallet layer, which locks on a
 * completely different key.
 */
export const casinoRoundLockKey = (roundId: string): string => `casino:lock:round:${roundId}`;

/**
 * Wallet idempotency key for a single bet placement — PER-TAP (keyed by the
 * client's own `clientBetId`), not per-item. This is what makes faithful
 * stacking possible: two different taps on the same item get two different
 * keys (two debits, two rows), while a replay of the SAME tap reuses the
 * SAME key (one debit, one row) — see `CasinoService.placeBet`.
 */
export const casinoBetIdempotencyKey = (
  roundId: string,
  userId: string,
  clientBetId: string,
): string => `casino-bet:${roundId}:${userId}:${clientBetId}`;

/**
 * Wallet idempotency key for a single WINNING bet's settlement credit —
 * keyed by `betId` (a `CasinoBet` row), not by user, so a multi-bet winner
 * gets one credit PER winning bet (each its own ledger row) while the
 * leaderboard/`payouts` map still sums those credits per user. See
 * `CasinoService.settleRound`.
 */
export const casinoWinIdempotencyKey = (roundId: string, betId: string): string =>
  `casino-win:${roundId}:${betId}`;

/**
 * Wallet idempotency key for a single bet's settlement-failure refund —
 * keyed by `betId`, mirroring `casinoWinIdempotencyKey`. Re-running the
 * refund path (e.g. a retry after a partial failure) reuses the same key per
 * bet, so the wallet's own idempotency guarantees no bet is ever refunded
 * twice. See `CasinoService.settleRound`'s refund-on-failure path.
 */
export const casinoRefundIdempotencyKey = (roundId: string, betId: string): string =>
  `casino-refund:${roundId}:${betId}`;

/** Rolling results history length kept per game (oldest dropped). */
export const HISTORY_LEN = 8;

/** Leaderboard size for a settled round's top winners. */
export const TOP_WINNERS = 3;

// ─────────────────────────────────────────────────────────────
// Audio-room window lifecycle sweep
// ─────────────────────────────────────────────────────────────

/**
 * Cadence of the orphan-window reconciliation (audio-room casino windows whose
 * room is no longer live). A low-frequency best-effort sweep — the DELETED /
 * ENDED / OWNERSHIP_TRANSFERRED event handlers are the primary path; this is
 * only the safety net for missed events or a crash between window-create and
 * room-end. Single-instance across replicas via a Redis lock.
 */
export const CASINO_WINDOW_SWEEP_INTERVAL_MS = 60_000;

/** Distributed-lock key guarding the orphan-window sweep (see `CASINO_WINDOW_SWEEP_INTERVAL_MS`). */
export const CASINO_WINDOW_SWEEP_LOCK_KEY = 'casino:window:monitor';

/**
 * Max rows in the sync payload's `recentWinners` list — a rolling "last N
 * wins across all players" feed, matching the old app's `getRecentWinners`
 * (`LIMIT 10` in both `greedy_food_socket.js` and `lucky_fruit_socket.js`).
 * Formatted as display strings (`"<username> won <glyph> <payout>"`) by the
 * gateway, not the repository — see `CasinoGateway.buildRecentWinners`.
 */
export const RECENT_WINNERS_LIMIT = 10;

/**
 * Max rows returned by a user's win-history query — matches the old app's
 * `LIMIT 100` verbatim (see `get_greedy_food_win_history`/`get_lucky_fruit_win_history`
 * in the old socket controllers). `CasinoService.getWinHistory` passes this
 * straight through to `CasinoRepository.winHistory`.
 */
export const WIN_HISTORY_LIMIT = 100;

// ─────────────────────────────────────────────────────────────
// Greedy Food
// ─────────────────────────────────────────────────────────────

/**
 * All 10 wheel outcomes with their payout multiplier. Every outcome is also
 * bettable (salads included) — payout is always the BET item's own
 * multiplier, never the outcome's (e.g. a `crab` bet still pays 45× when the
 * outcome is `nonVegSalad`).
 */
export const GREEDY_MULTIPLIERS: Record<string, number> = {
  carrot: 5,
  corn: 5,
  broccoli: 5,
  tomato: 5,
  burger: 10,
  chicken: 15,
  mutton: 25,
  crab: 45,
  vegSalad: 5,
  nonVegSalad: 10,
};

/** All 10 bettable/outcome items (keys of GREEDY_MULTIPLIERS). */
export const GREEDY_ITEMS = Object.keys(GREEDY_MULTIPLIERS);

/** VEG classification — `vegSalad` outcome pays every VEG bet. */
export const GREEDY_VEG = ['carrot', 'corn', 'broccoli', 'tomato'];

/** NON_VEG classification — `nonVegSalad` outcome pays every NON_VEG bet. */
export const GREEDY_NONVEG = ['burger', 'chicken', 'mutton', 'crab'];

// ─────────────────────────────────────────────────────────────
// Lucky Fruit
// ─────────────────────────────────────────────────────────────

/**
 * All 10 wheel outcomes with their payout multiplier. `smallLucky` and
 * `bigLucky` are outcome-only bonus segments (not directly bettable, 0 own
 * multiplier) — a winning `smallLucky` outcome pays every SMALL bet at 5×,
 * and a winning `bigLucky` outcome pays every BIG bet at that bet's own
 * multiplier.
 */
export const LUCKY_MULTIPLIERS: Record<string, number> = {
  pineapple: 5,
  kiwi: 5,
  blueberry: 5,
  peach: 5,
  pear: 10,
  coconut: 15,
  dragonFruit: 25,
  muskmelon: 45,
  smallLucky: 0,
  bigLucky: 0,
};

/** SMALL classification — `smallLucky` outcome pays every SMALL bet at 5×. */
export const LUCKY_SMALL = ['pineapple', 'kiwi', 'blueberry', 'peach'];

/** BIG classification — `bigLucky` outcome pays every BIG bet its own multiplier. */
export const LUCKY_BIG = ['pear', 'coconut', 'dragonFruit', 'muskmelon'];

/** The 8 symbols a player may actually place a bet on. */
export const LUCKY_BETTABLE = [...LUCKY_SMALL, ...LUCKY_BIG];

/** All 10 possible wheel outcomes, including the 2 outcome-only bonus segments. */
export const LUCKY_OUTCOMES = [...LUCKY_BETTABLE, 'smallLucky', 'bigLucky'];

// ─────────────────────────────────────────────────────────────
// Socket event names (verbatim from the old app — client and Flutter
// listeners key off these exact strings)
// ─────────────────────────────────────────────────────────────

export const CASINO_EVENTS = {
  GREEDY: {
    JOIN: 'join_greedy_food',
    LEAVE: 'leave_greedy_food',
    BET: 'place_casino_bet',
    HISTORY_REQ: 'get_greedy_food_win_history',
    SYNC: 'greedy_food_sync',
    TICK: 'greedy_food_tick',
    NEW_ROUND: 'greedy_food_new_round',
    SPIN: 'greedy_food_spin',
    RESULTS: 'greedy_food_results',
    POOL: 'greedy_food_pool_update',
    BET_OK: 'bet_placed_success',
    HISTORY: 'greedy_food_win_history',
  },
  LUCKY: {
    JOIN: 'join_lucky_fruit',
    LEAVE: 'leave_lucky_fruit',
    BET: 'place_lucky_fruit_bet',
    HISTORY_REQ: 'get_lucky_fruit_win_history',
    SYNC: 'lucky_fruit_sync',
    TICK: 'lucky_fruit_tick',
    RESULT: 'lucky_fruit_result',
    SETTLEMENT: 'lucky_fruit_settlement',
    POOL: 'lucky_fruit_pool_update',
    BET_OK: 'lucky_fruit_bet_placed',
    HISTORY: 'lucky_fruit_win_history',
  },
  ERROR: 'casino_error',
} as const;
