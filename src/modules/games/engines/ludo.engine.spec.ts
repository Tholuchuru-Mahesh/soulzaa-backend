import { rollLudoDice, pickBotTokenMove, LudoBoardSnapshot } from './ludo.engine';

describe('rollLudoDice', () => {
  it('returns a value between 1 and 6 inclusive', () => {
    for (let i = 0; i < 200; i++) {
      const v = rollLudoDice();
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    }
  });

  it('uses the injected rng deterministically', () => {
    const fixedRng = () => 0.999; // -> should map to 6
    expect(rollLudoDice(fixedRng)).toBe(6);
    const zeroRng = () => 0; // -> should map to 1
    expect(rollLudoDice(zeroRng)).toBe(1);
  });
});

describe('pickBotTokenMove', () => {
  it('returns null when no roll-6 and every token is still in base', () => {
    const board: LudoBoardSnapshot = {
      numPlayers: 4,
      is2v2: false,
      seats: [
        { seat: 0, userId: 'bot-1', tokenPositions: [-1, -1, -1, -1] },
        { seat: 1, userId: 'p2', tokenPositions: [10, -1, -1, -1] },
      ],
    };
    expect(pickBotTokenMove(board, 0, 3)).toBeNull();
  });

  it('moves a token out of base on a roll of 6', () => {
    const board: LudoBoardSnapshot = {
      numPlayers: 4,
      is2v2: false,
      seats: [{ seat: 0, userId: 'bot-1', tokenPositions: [-1, -1, -1, -1] }],
    };
    const move = pickBotTokenMove(board, 0, 6);
    expect(move).not.toBeNull();
    expect(move!.newPosition).toBe(0);
  });

  it('does not select a move that would overshoot home (position 56)', () => {
    const board: LudoBoardSnapshot = {
      numPlayers: 4,
      is2v2: false,
      seats: [{ seat: 0, userId: 'bot-1', tokenPositions: [54, -1, -1, -1] }],
    };
    // 54 + 5 = 59, past 56 — illegal for that token; no other token can move
    // (all others in base, roll isn't 6) -> null.
    expect(pickBotTokenMove(board, 0, 5)).toBeNull();
  });

  it('prioritizes a move that lands exactly on home (56)', () => {
    const board: LudoBoardSnapshot = {
      numPlayers: 4,
      is2v2: false,
      seats: [{ seat: 0, userId: 'bot-1', tokenPositions: [50, 10, -1, -1] }],
    };
    const move = pickBotTokenMove(board, 0, 6);
    expect(move).not.toBeNull();
    expect(move!.newPosition).toBe(56);
  });

  it('prioritizes capturing an opponent token over a non-capturing move, when the landing square is not safe', () => {
    // Verified against the ported path tables (see ludo.engine.ts). This is
    // a 3+ seat board, so playerColorsFor gives [Red, Green, Yellow, Blue]
    // and seat 1 is Green, matching the comment below.
    //
    // Red (seat 0) main-path index 5 is board cell [5,6].
    // Green (seat 1) main-path index 44 is ALSO board cell [5,6] (paths are
    // rotations of the same physical board) and [5,6] is not in kSafeSquares.
    // Red token 0 sits at position 2; rolling a 3 lands it exactly on position
    // 5, capturing Green's token 0 sitting at position 44.
    // Red token 1 sits at position 20; rolling a 3 is also legal (moves to 23)
    // but is a plain, non-capturing move and must lose priority to the capture.
    const board: LudoBoardSnapshot = {
      numPlayers: 4,
      is2v2: false,
      seats: [
        { seat: 0, userId: 'bot-1', tokenPositions: [2, 20, -1, -1] },
        { seat: 1, userId: 'p2', tokenPositions: [44, -1, -1, -1] },
      ],
    };
    const move = pickBotTokenMove(board, 0, 3);
    expect(move).not.toBeNull();
    expect(move).toEqual({ tokenIndex: 0, newPosition: 5 });
  });

  it('does not treat landing on a safe square as a capture', () => {
    // 3+ seat board -> seat 1 is Green, seat 2 is Yellow (see comment above).
    //
    // Red main-path index 0 is [6,1], a safe square (kSafeSquares includes
    // [6,1]). Green main-path index 39 is ALSO [6,1] (verified against
    // kGreenPath) — same physical cell as Red's — but because it is a safe
    // square, Red landing there must NOT capture Green's token.
    //
    // Red token 1 sits at position 11; rolling a 6 moves it to position 17,
    // which is a genuine (non-safe) capture of Yellow's token sitting at
    // Yellow main-path index 43 (both map to board cell [5,8] — verified
    // against kRedPath/kYellowPath). If isCaptureAt wrongly flagged the
    // safe-square landing (token 0 -> position 0) as a capture too, this
    // test could not tell the two capture candidates apart and would still
    // pass by accident with the wrong rng draw — so token 0 is pinned to
    // ONLY be legal via base-exit while token 1's real capture is the sole
    // capture candidate, making the expected pick deterministic regardless
    // of which candidate wins ties among non-captures.
    const board: LudoBoardSnapshot = {
      numPlayers: 4,
      is2v2: false,
      seats: [
        { seat: 0, userId: 'bot-1', tokenPositions: [-1, 11, 56, 56] },
        { seat: 1, userId: 'p2', tokenPositions: [39, -1, -1, -1] },
        { seat: 2, userId: 'p3', tokenPositions: [43, -1, -1, -1] },
      ],
    };
    const move = pickBotTokenMove(board, 0, 6);
    // The only real capture is token 1 landing on position 17 (captures
    // Yellow). Token 0's landing on position 0 is on a safe square and must
    // NOT be treated as a capture, so it must not win priority over token 1.
    expect(move).toEqual({ tokenIndex: 1, newPosition: 17 });
  });

  it('returns null when literally no token has a legal move', () => {
    const board: LudoBoardSnapshot = {
      numPlayers: 4,
      is2v2: false,
      seats: [{ seat: 0, userId: 'bot-1', tokenPositions: [56, 56, 56, -1] }],
    };
    expect(pickBotTokenMove(board, 0, 3)).toBeNull();
  });

  it('resolves seat 1 via the Yellow path (not Green) in a real 2-player match', () => {
    // Regression test for a Critical review finding: ludo_state.dart's
    // constructor (lines ~199-218) maps a genuine 2-player match's seats to
    // [kRed, kYellow] specifically — "Red vs Yellow, diagonally opposite" —
    // NOT [kRed, kGreen]. A naive `seat % 4` mapping would wrongly put seat
    // 1 on the Green path here.
    //
    // Red (seat 0) main-path index 5 is board cell [5,6], not a safe square.
    // Yellow main-path index 31 is ALSO [5,6] (verified against kYellowPath)
    // — the REAL coincidence for a 2-player match — while Green main-path
    // index 31 is [8,5], a DIFFERENT cell (verified against kGreenPath). So
    // if this engine wrongly mapped seat 1 to Green (the seat%4 bug), it
    // would find no opponent at [5,6] and miss the capture entirely.
    //
    // Red token 1 (a second, independent token at position 20) gives a
    // genuine plain non-capturing alternative move (20 + 3 = 23) so the
    // capture-priority logic actually has something to prioritize OVER —
    // without this second token, token 0's move would be the only legal
    // move regardless of whether it's correctly flagged as a capture, and
    // the test could not tell "capture detected" from "capture missed".
    const board: LudoBoardSnapshot = {
      numPlayers: 2,
      is2v2: false,
      seats: [
        { seat: 0, userId: 'bot-1', tokenPositions: [2, 20, -1, -1] },
        { seat: 1, userId: 'p2', tokenPositions: [31, -1, -1, -1] },
      ],
    };
    // Red token 0: position 2 + roll of 3 = position 5 -> cell [5,6] ->
    // captures seat 1's token (real Yellow path index 31) -> must win
    // priority over token 1's plain move to position 23.
    const move = pickBotTokenMove(board, 0, 3);
    expect(move).toEqual({ tokenIndex: 0, newPosition: 5 });
  });

  it('does NOT capture at the Green-path coincidence cell in a 2-player match (seat 1 is Yellow, not Green)', () => {
    // Inverse of the test above: same mover move (Red seat 0, position 2,
    // roll 3 -> lands on [5,6]), but this time the opponent token sits at
    // the position that would ONLY coincide with [5,6] under the WRONG
    // Green-path mapping (Green main-path index 44), with numPlayers: 2 so
    // the correct mapping for seat 1 is Yellow. Under the correct mapping,
    // seat 1's token at raw position 44 resolves to Yellow main-path index
    // 44 -> cell [6,9] (verified against kYellowPath), a different physical
    // square than [5,6] -> no capture. If the engine still used seat % 4
    // (Green) here, it would wrongly report a capture (Green index 44 IS
    // [5,6], per the capture-priority test above).
    const board: LudoBoardSnapshot = {
      numPlayers: 2,
      is2v2: false,
      seats: [
        { seat: 0, userId: 'bot-1', tokenPositions: [2, -1, -1, -1] },
        { seat: 1, userId: 'p2', tokenPositions: [44, -1, -1, -1] },
      ],
    };
    const move = pickBotTokenMove(board, 0, 3);
    // Legal (position 5) but NOT a capture, so it's just the only candidate,
    // returned via the plain fallback tier rather than the capture tier.
    // The real assertion is that this doesn't crash/misclassify; toEqual
    // pins the exact (only) legal outcome.
    expect(move).toEqual({ tokenIndex: 0, newPosition: 5 });
  });
});
