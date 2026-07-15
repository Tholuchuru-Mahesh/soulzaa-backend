/**
 * In-session live state for board games (Ludo/Carrom/UNO/Domino) — the platform
 * relays client moves without validating game rules (peer-relay model, preserved
 * from the legacy backend). This module is the pure, side-effect-free core: the
 * move log + turn pointer and the exact turn-rotation semantics. It is persisted
 * to Redis by GamesService (keyed by session) and never touches money.
 *
 * Turn semantics reproduced verbatim from the old `send_game_move` handler:
 *  - For "whitelisted" actions the CLIENT owns turn order — the server does NOT
 *    rotate (the client sends the next move / an explicit nextTurnPlayerId).
 *  - An explicit truthy `nextTurnPlayerId` always wins.
 *  - `noTurnChange` suppresses rotation.
 *  - Otherwise the server rotates to the next seat.
 *  - `game_over` latches `isOver`.
 *  - `sync_state` replaces the whole move log (log compaction); `aim` is never
 *    stored (ephemeral live preview); everything else is appended.
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
  };
}

/** Next seat after `current` in `seatOrder`, wrapping around. */
function nextSeat(seatOrder: string[], current: string | null): string | null {
  if (seatOrder.length === 0) return null;
  const idx = current ? seatOrder.indexOf(current) : -1;
  return seatOrder[(idx + 1) % seatOrder.length];
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

  // Turn handling.
  let currentTurnUserId = state.currentTurnUserId;
  let turnStartedAt = state.turnStartedAt;
  const explicitNext = frame.moveData.nextTurnPlayerId;
  const noTurnChange = frame.moveData.noTurnChange === true;
  if (explicitNext !== undefined && explicitNext !== null && explicitNext !== '') {
    currentTurnUserId = String(explicitNext);
    turnStartedAt = frame.timestamp;
  } else if (!noTurnChange && !TURN_WHITELIST.has(action)) {
    currentTurnUserId = nextSeat(state.seatOrder, state.currentTurnUserId);
    turnStartedAt = frame.timestamp;
  }

  return {
    ...state,
    moves,
    currentTurnUserId,
    turnStartedAt,
    isOver: state.isOver || action === 'game_over',
  };
}
