/**
 * Pure Ludo engine used ONLY to drive BOT seats server-side (see
 * LudoBotDriverService, Task 2). Reimplements the minimum subset of the
 * mobile client's LudoGameState rules
 * (lib/features/games/games/ludo/ludo_state.dart, soulzaa-mobile) needed to
 * produce ONE legal move per bot turn — not a full port, and not used to
 * validate HUMAN moves (the peer-relay model for human moves is unchanged by
 * this plan).
 *
 * A move this engine picks is relayed through the EXISTING relayMove/
 * applyMove pipeline as an ordinary 'roll_dice'/'move_token' frame, so every
 * mobile client (old or new) replays it exactly like a human's move — this
 * file's only job is to choose a move a real client's own rules would also
 * consider legal, so nothing desyncs.
 *
 * Path tables and safe squares below are ported verbatim (row/col values)
 * from ludo_state.dart's kRedPath/kGreenPath/kYellowPath/kBluePath and
 * kSafeSquares. Each color's path is a 57-entry rotation of the SAME
 * physical 15x15 board (0-50 main path shared with other colors, 51-56 a
 * private home column, 56 = finished). Capture legality therefore can NOT be
 * decided by comparing raw path indices across seats (index 5 on Red's path
 * and index 5 on Green's path are different physical cells) — it must
 * compare the actual [row, col] board cell each token's own path maps its
 * position to, exactly like `_checkCapture`/`aiPickToken` do in the Dart
 * source via `tok.cell` / `pathFor(playerIndex)[step]`.
 */

// Safe squares [row, col] — tokens here cannot be captured (ludo_state.dart kSafeSquares).
const SAFE_SQUARES: ReadonlyArray<readonly [number, number]> = [
  [6, 1],
  [6, 2], // Red start area
  [1, 8],
  [2, 8], // Green start area
  [8, 13],
  [8, 12], // Yellow start area
  [13, 6],
  [12, 6], // Blue start area
  [1, 6],
  [6, 13],
  [13, 8],
  [8, 1], // star squares
];

// Paths (57 entries each: 0-50 main path, 51-56 home column, 56 = home center).
// Ported verbatim from ludo_state.dart kRedPath/kGreenPath/kYellowPath/kBluePath.

const RED_PATH: ReadonlyArray<readonly [number, number]> = [
  [6, 1],
  [6, 2],
  [6, 3],
  [6, 4],
  [6, 5],
  [5, 6],
  [4, 6],
  [3, 6],
  [2, 6],
  [1, 6],
  [0, 6],
  [0, 7],
  [0, 8],
  [1, 8],
  [2, 8],
  [3, 8],
  [4, 8],
  [5, 8],
  [6, 9],
  [6, 10],
  [6, 11],
  [6, 12],
  [6, 13],
  [6, 14],
  [7, 14],
  [8, 14],
  [8, 13],
  [8, 12],
  [8, 11],
  [8, 10],
  [8, 9],
  [9, 8],
  [10, 8],
  [11, 8],
  [12, 8],
  [13, 8],
  [14, 8],
  [14, 7],
  [14, 6],
  [13, 6],
  [12, 6],
  [11, 6],
  [10, 6],
  [9, 6],
  [8, 5],
  [8, 4],
  [8, 3],
  [8, 2],
  [8, 1],
  [8, 0],
  [7, 0],
  [7, 1],
  [7, 2],
  [7, 3],
  [7, 4],
  [7, 5],
  [7, 6],
];

const GREEN_PATH: ReadonlyArray<readonly [number, number]> = [
  [1, 8],
  [2, 8],
  [3, 8],
  [4, 8],
  [5, 8],
  [6, 9],
  [6, 10],
  [6, 11],
  [6, 12],
  [6, 13],
  [6, 14],
  [7, 14],
  [8, 14],
  [8, 13],
  [8, 12],
  [8, 11],
  [8, 10],
  [8, 9],
  [9, 8],
  [10, 8],
  [11, 8],
  [12, 8],
  [13, 8],
  [14, 8],
  [14, 7],
  [14, 6],
  [13, 6],
  [12, 6],
  [11, 6],
  [10, 6],
  [9, 6],
  [8, 5],
  [8, 4],
  [8, 3],
  [8, 2],
  [8, 1],
  [8, 0],
  [7, 0],
  [6, 0],
  [6, 1],
  [6, 2],
  [6, 3],
  [6, 4],
  [6, 5],
  [5, 6],
  [4, 6],
  [3, 6],
  [2, 6],
  [1, 6],
  [0, 6],
  [0, 7],
  [1, 7],
  [2, 7],
  [3, 7],
  [4, 7],
  [5, 7],
  [6, 7],
];

const YELLOW_PATH: ReadonlyArray<readonly [number, number]> = [
  [8, 13],
  [8, 12],
  [8, 11],
  [8, 10],
  [8, 9],
  [9, 8],
  [10, 8],
  [11, 8],
  [12, 8],
  [13, 8],
  [14, 8],
  [14, 7],
  [14, 6],
  [13, 6],
  [12, 6],
  [11, 6],
  [10, 6],
  [9, 6],
  [8, 5],
  [8, 4],
  [8, 3],
  [8, 2],
  [8, 1],
  [8, 0],
  [7, 0],
  [6, 0],
  [6, 1],
  [6, 2],
  [6, 3],
  [6, 4],
  [6, 5],
  [5, 6],
  [4, 6],
  [3, 6],
  [2, 6],
  [1, 6],
  [0, 6],
  [0, 7],
  [0, 8],
  [1, 8],
  [2, 8],
  [3, 8],
  [4, 8],
  [5, 8],
  [6, 9],
  [6, 10],
  [6, 11],
  [6, 12],
  [6, 13],
  [6, 14],
  [7, 14],
  [7, 13],
  [7, 12],
  [7, 11],
  [7, 10],
  [7, 9],
  [7, 8],
];

const BLUE_PATH: ReadonlyArray<readonly [number, number]> = [
  [13, 6],
  [12, 6],
  [11, 6],
  [10, 6],
  [9, 6],
  [8, 5],
  [8, 4],
  [8, 3],
  [8, 2],
  [8, 1],
  [8, 0],
  [7, 0],
  [6, 0],
  [6, 1],
  [6, 2],
  [6, 3],
  [6, 4],
  [6, 5],
  [5, 6],
  [4, 6],
  [3, 6],
  [2, 6],
  [1, 6],
  [0, 6],
  [0, 7],
  [0, 8],
  [1, 8],
  [2, 8],
  [3, 8],
  [4, 8],
  [5, 8],
  [6, 9],
  [6, 10],
  [6, 11],
  [6, 12],
  [6, 13],
  [6, 14],
  [7, 14],
  [8, 14],
  [8, 13],
  [8, 12],
  [8, 11],
  [8, 10],
  [8, 9],
  [9, 8],
  [10, 8],
  [11, 8],
  [12, 8],
  [13, 8],
  [14, 8],
  [14, 7],
  [13, 7],
  [12, 7],
  [11, 7],
  [10, 7],
  [9, 7],
  [8, 7],
];

const PATHS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  RED_PATH,
  GREEN_PATH,
  YELLOW_PATH,
  BLUE_PATH,
];

// Player color constants, matching ludo_state.dart's kRed/kGreen/kYellow/kBlue.
const RED = 0;
const GREEN = 1;
const YELLOW = 2;
const BLUE = 3;

/**
 * Ports ludo_state.dart's `LudoGameState` constructor branch (lines ~199-218
 * of ludo_state.dart) that builds `playerColors`, EXACTLY:
 *
 * ```dart
 * if (is2v2) {
 *   playerColors = [kRed, kGreen, kYellow, kBlue]; // 2v2 has 4 players
 * } else if (numPlayers == 2) {
 *   playerColors = [kRed, kYellow]; // Red (0) vs Yellow (2) diagonally opposite
 * } else {
 *   playerColors = [kRed, kGreen, kYellow, kBlue];
 * }
 * ```
 *
 * Critical: a real 2-player match is NOT seats [Red, Green] — it is seats
 * [Red, Yellow] (diagonally opposite corners of the board), confirmed live
 * in ludo_controller.dart's online-multiplayer path (seat count comes from
 * session.participants and is fed straight into this constructor). Using
 * `seat % 4` here would put seat 1's tokens on the Green path in a 2-player
 * match, which is a physically different board rotation than the Yellow
 * path the real client uses — every capture check for that seat would then
 * compare cells that don't correspond to any real board square, exactly the
 * "server picks a move a real client would refuse to accept as legal"
 * failure this engine exists to prevent.
 */
function playerColorsFor(numPlayers: number, is2v2: boolean): number[] {
  if (is2v2) return [RED, GREEN, YELLOW, BLUE];
  if (numPlayers === 2) return [RED, YELLOW];
  return [RED, GREEN, YELLOW, BLUE];
}

/**
 * Maps a seat number to its path table for this board, mirroring
 * ludo_state.dart's `pathFor(playerColors[seatIndex])` call pattern (see
 * e.g. line 567's `pathFor(playerColors[targetPlayer])`). Seat is used as
 * an index into `playerColorsFor(...)` (matching the Dart `pi`/`playerIdx`
 * convention — seats are 0-based positions among the match's participants,
 * not raw color ids) to get the color, then that color selects the path
 * table.
 */
function pathForSeat(
  board: LudoBoardSnapshot,
  seat: number,
): ReadonlyArray<readonly [number, number]> {
  const colors = playerColorsFor(board.numPlayers, board.is2v2);
  const color = colors[seat] ?? RED; // mirrors pathFor's Dart `default: return kRedPath;`
  return PATHS[color] ?? RED_PATH;
}

function isSafeCell(cell: readonly [number, number]): boolean {
  return SAFE_SQUARES.some((s) => s[0] === cell[0] && s[1] === cell[1]);
}

export function rollLudoDice(rng: () => number = Math.random): number {
  return Math.floor(rng() * 6) + 1;
}

export interface LudoBotSeatInfo {
  seat: number;
  userId: string;
  tokenPositions: number[]; // length 4; -1 = base, 0-50 = main path, 51-56 = home column/home
}

export interface LudoBoardSnapshot {
  seats: LudoBotSeatInfo[];
  /**
   * Total seats in the match (ludo_state.dart's `numPlayers`), NOT the count
   * of seats present in `seats` (a snapshot may omit withdrawn/finished
   * seats' entries while numPlayers stays fixed for the match's lifetime).
   * Required because seat->color->path mapping depends on it: a 2-player
   * match uses [Red, Yellow], not [Red, Green, ...] (see `playerColorsFor`).
   */
  numPlayers: number;
  /** ludo_state.dart's `is2v2` — forces the 4-player [Red,Green,Yellow,Blue] color mapping regardless of numPlayers. */
  is2v2: boolean;
}

interface CandidateMove {
  tokenIndex: number;
  newPosition: number;
  isCapture: boolean;
  reachesHome: boolean;
}

function legalMovesFor(
  board: LudoBoardSnapshot,
  actingSeat: number,
  diceValue: number,
): CandidateMove[] {
  const seat = board.seats.find((s) => s.seat === actingSeat);
  if (!seat) return [];
  const moves: CandidateMove[] = [];
  seat.tokenPositions.forEach((pos, tokenIndex) => {
    let newPosition: number;
    if (pos === -1) {
      if (diceValue !== 6) return;
      newPosition = 0;
    } else {
      if (pos >= 56) return; // already finished, cannot move
      newPosition = pos + diceValue;
      if (newPosition > 56) return;
    }
    const isCapture = isCaptureAt(board, actingSeat, newPosition);
    moves.push({ tokenIndex, newPosition, isCapture, reachesHome: newPosition === 56 });
  });
  return moves;
}

/**
 * Mirrors ludo_state.dart's `_checkCapture`: a move captures when the
 * MOVER's new main-path position maps (via the mover's own path table) to
 * the same physical board [row, col] cell that some OTHER seat's token
 * currently occupies (via that other seat's own path table) — never by
 * comparing raw position numbers across seats, since each color's path is a
 * different rotation of the same board. No capture:
 *  - off the main path (position < 0 or > 50 — home column/base is private
 *    per color and never shared board space),
 *  - onto a safe square (kSafeSquares),
 *  - against a token that is itself in its home column or finished
 *    (position >= 51 in ludo_state.dart's `step >= 51` / `!isOnBoard`
 *    checks — home-column cells are private per color and not shared board
 *    space either).
 */
function isCaptureAt(board: LudoBoardSnapshot, actingSeat: number, newPosition: number): boolean {
  if (newPosition < 0 || newPosition > 50) return false;

  const moverCell = pathForSeat(board, actingSeat)[newPosition];
  if (isSafeCell(moverCell)) return false;

  for (const otherSeat of board.seats) {
    if (otherSeat.seat === actingSeat) continue;
    const otherPath = pathForSeat(board, otherSeat.seat);
    for (const oppPos of otherSeat.tokenPositions) {
      if (oppPos < 0 || oppPos > 50) continue; // base, home column, or finished: not on shared board
      const oppCell = otherPath[oppPos];
      if (oppCell[0] === moverCell[0] && oppCell[1] === moverCell[1]) {
        return true;
      }
    }
  }
  return false;
}

export function pickBotTokenMove(
  board: LudoBoardSnapshot,
  actingSeat: number,
  diceValue: number,
  rng: () => number = Math.random,
): { tokenIndex: number; newPosition: number } | null {
  const candidates = legalMovesFor(board, actingSeat, diceValue);
  if (candidates.length === 0) return null;

  // Priority 0 (this engine's own addition, per brief rule #3 — the mobile
  // aiPickToken has no equivalent explicit tier, see report for rationale):
  // finish a token if possible.
  const homeMoves = candidates.filter((c) => c.reachesHome);
  if (homeMoves.length > 0) return pick(homeMoves, rng);

  // Priority 1 (matches ludo_state.dart aiPickToken): capture an opponent.
  const captureMoves = candidates.filter((c) => c.isCapture);
  if (captureMoves.length > 0) return pick(captureMoves, rng);

  // Priority 2/3 (simplified — see report): any remaining legal move.
  return pick(candidates, rng);
}

function pick(
  moves: CandidateMove[],
  rng: () => number,
): { tokenIndex: number; newPosition: number } {
  const idx = Math.floor(rng() * moves.length);
  const m = moves[idx] ?? moves[0];
  return { tokenIndex: m.tokenIndex, newPosition: m.newPosition };
}
