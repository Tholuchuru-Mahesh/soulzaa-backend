/**
 * In-session live state for board games (Ludo/Carrom) — the platform
 * relays client moves without validating game rules (peer-relay model, preserved
 * from the legacy backend). This module is the pure, side-effect-free core: the
 * move log + turn pointer and the exact turn-rotation semantics. It is persisted
 * to Redis by GamesService (keyed by session) and never touches money.
 *
 * Turn semantics reproduced verbatim from the old `send_game_move` handler:
 *  - For "whitelisted" actions the CLIENT owns turn order — the server does NOT
 *    rotate (the client sends the next move / an explicit nextTurnPlayerId).
 *  - An explicit truthy `nextTurnPlayerId` always wins, PROVIDED (a) the mover
 *    currently holds the turn and (b) the requested seat is a real member of
 *    seatOrder — otherwise the override is ignored and normal rotation rules
 *    apply. Without this, any active participant could hijack the turn
 *    pointer (or point it at a bogus id) by relaying a single crafted move.
 *  - `noTurnChange` suppresses rotation.
 *  - Otherwise the server rotates to the next seat.
 *  - `game_over` latches `isOver`.
 *  - `sync_state` replaces the whole move log (log compaction); `aim` is never
 *    stored (ephemeral live preview); everything else is appended.
 *  - Only the seat that currently holds the turn may act at all (`canAct`),
 *    except `sync_state`, which any active participant may send to resync a
 *    desynced client's view of the board — it can never itself move the turn
 *    pointer (rule (a) above still applies to its nextTurnPlayerId).
 */

/** A single relayed move. `moveData` is an opaque, client-defined per-game envelope. */
export interface GameMoveFrame {
  playerId: string;
  moveData: Record<string, unknown>;
  timestamp: number;
}

/** Per-session live state held between moves (Redis-backed, not persisted to SQL). */
export interface GameLiveState {
  currentTurnUserId: string | null;
  turnStartedAt: number;
  turnSeconds: number;
  /** Seat order = participant join order; rotation walks this list. */
  seatOrder: string[];
  moves: GameMoveFrame[];
  isOver: boolean;
  /**
   * Consecutive turn-watchdog timeouts per seat (userId -> count). Reset to 0
   * whenever that seat completes a turn normally; incremented when the
   * watchdog force-advances past them. Lets the watchdog fold a client that's
   * stuck turn after turn into the normal forfeit path.
   */
  timeoutCounts: Record<string, number>;
}

/**
 * Actions where the client drives turn order — the server must NOT auto-rotate
 * after relaying them. Copied exactly from the legacy `send_game_move` whitelist.
 */
export const TURN_WHITELIST: ReadonlySet<string> = new Set([
  'sync_state',
  'shoot',
  'aim',
  'roll_dice',
  'move_token',
  'play_card',
  'draw_card',
]);

/** Build the initial state for a freshly started session. */
export function initLiveState(
  seatOrder: string[],
  startedAtMs: number,
  turnSeconds: number,
): GameLiveState {
  return {
    currentTurnUserId: seatOrder[0] ?? null,
    turnStartedAt: startedAtMs,
    turnSeconds,
    seatOrder: [...seatOrder],
    moves: [],
    isOver: false,
    timeoutCounts: {},
  };
}

/** Next seat after `current` in `seatOrder`, wrapping around. */
function nextSeat(seatOrder: string[], current: string | null): string | null {
  if (seatOrder.length === 0) return null;
  const idx = current ? seatOrder.indexOf(current) : -1;
  return seatOrder[(idx + 1) % seatOrder.length];
}

/**
 * Whether `frame.playerId` is allowed to act at all right now. Only the seat
 * currently holding the turn may relay turn-consuming moves; `sync_state` is
 * the sole exception (any active participant may resync the board), and it
 * can never move the turn pointer itself — see `applyMove`. Callers (e.g.
 * `GamesService.relayMove`) must check this BEFORE calling `applyMove` and
 * reject the request outright if it's false — this is the primary defense
 * against turn hijacking in the peer-relay model.
 */
export function canAct(state: GameLiveState, frame: GameMoveFrame): boolean {
  const action = typeof frame.moveData.action === 'string' ? frame.moveData.action : '';
  if (action === 'sync_state') return true;
  return frame.playerId === state.currentTurnUserId;
}

/** Apply a relayed move, returning a NEW state (never mutates the input). */
export function applyMove(state: GameLiveState, frame: GameMoveFrame): GameLiveState {
  const action = typeof frame.moveData.action === 'string' ? frame.moveData.action : '';

  // Move-log handling: sync_state compacts the log to one snapshot; aim is
  // ephemeral (not stored); everything else appends in order.
  let moves: GameMoveFrame[];
  if (action === 'sync_state') {
    moves = [frame];
  } else if (action === 'aim') {
    moves = state.moves;
  } else {
    moves = [...state.moves, frame];
  }

  // Turn handling. An explicit nextTurnPlayerId is only honored from the seat
  // that currently holds the turn, and only if it names a real seat —
  // otherwise it's ignored and normal rotation rules apply. This closes the
  // turn-hijack vector where a crafted nextTurnPlayerId (via any whitelisted
  // action, or via sync_state, which callers must allow from any
  // participant) could hand the turn to an arbitrary — or non-existent —
  // player.
  let currentTurnUserId = state.currentTurnUserId;
  let turnStartedAt = state.turnStartedAt;
  const explicitNext = frame.moveData.nextTurnPlayerId;
  const noTurnChange = frame.moveData.noTurnChange === true;
  const movesTurnOwner = frame.playerId === state.currentTurnUserId;
  if (
    movesTurnOwner &&
    explicitNext !== undefined &&
    explicitNext !== null &&
    explicitNext !== '' &&
    state.seatOrder.includes(String(explicitNext))
  ) {
    currentTurnUserId = String(explicitNext);
    turnStartedAt = frame.timestamp;
  } else if (movesTurnOwner && !noTurnChange && !TURN_WHITELIST.has(action)) {
    currentTurnUserId = nextSeat(state.seatOrder, state.currentTurnUserId);
    turnStartedAt = frame.timestamp;
  }

  // A real move from the mover's seat proves it isn't stuck — clear its
  // watchdog strike count. Only relevant once the seat holds the turn again.
  const timeoutCounts =
    frame.playerId in state.timeoutCounts && state.timeoutCounts[frame.playerId] !== 0
      ? { ...state.timeoutCounts, [frame.playerId]: 0 }
      : state.timeoutCounts;

  return {
    ...state,
    moves,
    currentTurnUserId,
    turnStartedAt,
    timeoutCounts,
    isOver: state.isOver || action === 'game_over',
  };
}

/**
 * Permanently drop a seat from rotation (a mid-match forfeit) and, if that
 * seat currently held the turn, hand it to whoever is next among the seats
 * still present. Without this, a forfeited seat stays in `seatOrder`
 * forever, and every future lap around the table stalls for a full
 * watchdog cycle waiting to skip a seat that can no longer ever move. Never
 * mutates the input.
 */
export function removeSeat(state: GameLiveState, userId: string, now: number): GameLiveState {
  const wasCurrentTurn = state.currentTurnUserId === userId;
  const nextUserId = wasCurrentTurn ? nextSeat(state.seatOrder, userId) : state.currentTurnUserId;
  const seatOrder = state.seatOrder.filter((id) => id !== userId);
  const timeoutCounts = { ...state.timeoutCounts };
  delete timeoutCounts[userId];
  return {
    ...state,
    seatOrder,
    currentTurnUserId: nextUserId === userId ? null : nextUserId,
    turnStartedAt: wasCurrentTurn ? now : state.turnStartedAt,
    timeoutCounts,
  };
}

/**
 * Server-forced turn rotation, used only by the turn watchdog when a turn has
 * sat unresolved past its grace period with no relayed move. Skips the stuck
 * seat, bumps its consecutive-timeout strike count, and clears the strike
 * count for whoever now holds the turn. Never mutates the input.
 */
export function forceAdvanceTurn(
  state: GameLiveState,
  now: number,
): { state: GameLiveState; skippedUserId: string | null; skippedStrikes: number } {
  const skippedUserId = state.currentTurnUserId;
  const nextUserId = nextSeat(state.seatOrder, skippedUserId);
  const skippedStrikes = skippedUserId ? (state.timeoutCounts[skippedUserId] ?? 0) + 1 : 0;

  const timeoutCounts = { ...state.timeoutCounts };
  if (skippedUserId) timeoutCounts[skippedUserId] = skippedStrikes;
  if (nextUserId) timeoutCounts[nextUserId] = 0;

  return {
    state: {
      ...state,
      currentTurnUserId: nextUserId,
      turnStartedAt: now,
      timeoutCounts,
    },
    skippedUserId,
    skippedStrikes,
  };
}
