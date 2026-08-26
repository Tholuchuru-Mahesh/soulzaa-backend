import {
  applyMove,
  canAct,
  forceAdvanceTurn,
  GameLiveState,
  GameMoveFrame,
  initLiveState,
  removeSeat,
} from './game-live-state';

const SEATS = ['u1', 'u2', 'u3', 'u4'];

function frame(playerId: string, moveData: Record<string, unknown>): GameMoveFrame {
  return { playerId, moveData, timestamp: 1000 };
}

function baseState(overrides: Partial<GameLiveState> = {}): GameLiveState {
  return { ...initLiveState(SEATS, 500, 30), ...overrides };
}

describe('game-live-state', () => {
  describe('initLiveState', () => {
    it('seats the first player as the current turn with an empty move log', () => {
      const state = initLiveState(SEATS, 500, 30);
      expect(state.currentTurnUserId).toBe('u1');
      expect(state.seatOrder).toEqual(SEATS);
      expect(state.moves).toEqual([]);
      expect(state.isOver).toBe(false);
      expect(state.turnStartedAt).toBe(500);
      expect(state.turnSeconds).toBe(30);
    });
  });

  describe('applyMove turn rotation', () => {
    it('does NOT rotate the turn for a whitelisted action (client owns turn order)', () => {
      const next = applyMove(baseState(), frame('u1', { action: 'roll_dice', value: 6 }));
      expect(next.currentTurnUserId).toBe('u1');
    });

    it('rotates to the next seat for a non-whitelisted action', () => {
      const next = applyMove(baseState(), frame('u1', { action: 'pass' }));
      expect(next.currentTurnUserId).toBe('u2');
      expect(next.turnStartedAt).toBe(1000);
    });

    it('wraps rotation around to the first seat', () => {
      const next = applyMove(
        baseState({ currentTurnUserId: 'u4' }),
        frame('u4', { action: 'pass' }),
      );
      expect(next.currentTurnUserId).toBe('u1');
    });

    it('honors an explicit truthy nextTurnPlayerId over rotation', () => {
      const next = applyMove(
        baseState(),
        frame('u1', { action: 'move_token', nextTurnPlayerId: 'u3' }),
      );
      expect(next.currentTurnUserId).toBe('u3');
    });

    it('suppresses rotation when noTurnChange is set', () => {
      const next = applyMove(baseState(), frame('u1', { action: 'pass', noTurnChange: true }));
      expect(next.currentTurnUserId).toBe('u1');
    });
  });

  describe('canAct (turn-ownership gate)', () => {
    it('allows the current turn holder to act', () => {
      expect(canAct(baseState(), frame('u1', { action: 'roll_dice' }))).toBe(true);
    });

    it('rejects a non-turn-holder attempting a normal action', () => {
      expect(canAct(baseState(), frame('u2', { action: 'roll_dice' }))).toBe(false);
    });

    it('allows sync_state from any participant regardless of whose turn it is', () => {
      expect(canAct(baseState(), frame('u3', { action: 'sync_state' }))).toBe(true);
    });
  });

  describe('applyMove turn-hijack prevention', () => {
    it('ignores nextTurnPlayerId from a mover who does not hold the turn', () => {
      // u1 holds the turn; u2 tries to steal it via a crafted nextTurnPlayerId.
      const next = applyMove(
        baseState(),
        frame('u2', { action: 'move_token', nextTurnPlayerId: 'u2' }),
      );
      expect(next.currentTurnUserId).toBe('u1');
    });

    it('does not rotate the turn on a move from a non-turn-holder', () => {
      const next = applyMove(baseState(), frame('u2', { action: 'pass' }));
      expect(next.currentTurnUserId).toBe('u1');
    });

    it('still appends a non-turn-holder move to the log (relayMove gates whether it is called at all)', () => {
      const next = applyMove(baseState(), frame('u2', { action: 'pass' }));
      expect(next.moves).toHaveLength(1);
    });

    it('ignores an explicit nextTurnPlayerId that does not name a real seat', () => {
      const next = applyMove(
        baseState(),
        frame('u1', { action: 'move_token', nextTurnPlayerId: 'not-a-real-seat' }),
      );
      // The bogus id is ignored; move_token is whitelisted (client owns turn
      // order), so the server does NOT auto-rotate — the turn stays put.
      expect(next.currentTurnUserId).toBe('u1');
    });

    it('falls back to normal rotation when a bogus id rides a non-whitelisted action', () => {
      // The other half of "ignored": for an action the server does own, the
      // crafted id must not freeze the turn on the sender either. It is
      // discarded and the seat rotates as it normally would.
      const next = applyMove(
        baseState(),
        frame('u1', { action: 'pass', nextTurnPlayerId: 'not-a-real-seat' }),
      );
      expect(next.currentTurnUserId).toBe('u2');
    });

    it('ignores nextTurnPlayerId on a sync_state sent by a non-turn-holder', () => {
      const next = applyMove(
        baseState(),
        frame('u3', { action: 'sync_state', nextTurnPlayerId: 'u3' }),
      );
      expect(next.currentTurnUserId).toBe('u1');
    });
  });

  describe('applyMove move log', () => {
    it('appends an ordinary move to the log', () => {
      const next = applyMove(baseState(), frame('u1', { action: 'roll_dice', value: 6 }));
      expect(next.moves).toHaveLength(1);
      expect(next.moves[0].moveData).toMatchObject({ action: 'roll_dice', value: 6 });
    });

    it('replaces the whole log with the snapshot on sync_state', () => {
      const state = baseState({
        moves: [frame('u1', { action: 'roll_dice' }), frame('u2', { action: 'move_token' })],
      });
      const next = applyMove(state, frame('u1', { action: 'sync_state', scores: { u1: 3 } }));
      expect(next.moves).toHaveLength(1);
      expect(next.moves[0].moveData).toMatchObject({ action: 'sync_state' });
    });

    it('does NOT store an aim frame in the log', () => {
      const next = applyMove(baseState(), frame('u1', { action: 'aim', angle: 42 }));
      expect(next.moves).toHaveLength(0);
    });
  });

  describe('applyMove game_over', () => {
    it('latches isOver on a game_over action', () => {
      const next = applyMove(baseState(), frame('u1', { action: 'game_over', winnerId: 'u1' }));
      expect(next.isOver).toBe(true);
    });
  });

  it('never mutates the input state (returns a new object)', () => {
    const state = baseState();
    const next = applyMove(state, frame('u1', { action: 'roll_dice' }));
    expect(state.moves).toHaveLength(0);
    expect(next).not.toBe(state);
  });

  describe('applyMove timeout-strike reset', () => {
    it('clears a mover seat strike count on a real relayed move', () => {
      const state = baseState({ timeoutCounts: { u1: 2 } });
      const next = applyMove(state, frame('u1', { action: 'roll_dice' }));
      expect(next.timeoutCounts.u1).toBe(0);
    });

    it('leaves other seats strike counts untouched', () => {
      const state = baseState({ timeoutCounts: { u1: 2, u2: 1 } });
      const next = applyMove(state, frame('u1', { action: 'roll_dice' }));
      expect(next.timeoutCounts.u2).toBe(1);
    });
  });

  describe('forceAdvanceTurn (turn watchdog)', () => {
    it('rotates past the stuck seat to the next one', () => {
      const state = baseState();
      const { state: next, skippedUserId } = forceAdvanceTurn(state, 5000);
      expect(skippedUserId).toBe('u1');
      expect(next.currentTurnUserId).toBe('u2');
      expect(next.turnStartedAt).toBe(5000);
    });

    it('wraps rotation around to the first seat', () => {
      const state = baseState({ currentTurnUserId: 'u4' });
      const { state: next } = forceAdvanceTurn(state, 5000);
      expect(next.currentTurnUserId).toBe('u1');
    });

    it('increments the skipped seat strike count and reports it', () => {
      const state = baseState({ timeoutCounts: { u1: 1 } });
      const { state: next, skippedStrikes } = forceAdvanceTurn(state, 5000);
      expect(skippedStrikes).toBe(2);
      expect(next.timeoutCounts.u1).toBe(2);
    });

    it('resets the strike count of the seat that now holds the turn', () => {
      const state = baseState({ timeoutCounts: { u2: 3 } });
      const { state: next } = forceAdvanceTurn(state, 5000);
      expect(next.currentTurnUserId).toBe('u2');
      expect(next.timeoutCounts.u2).toBe(0);
    });

    it('never mutates the input state', () => {
      const state = baseState({ timeoutCounts: { u1: 1 } });
      forceAdvanceTurn(state, 5000);
      expect(state.currentTurnUserId).toBe('u1');
      expect(state.timeoutCounts.u1).toBe(1);
    });

    it('is a no-op turn-wise when no seats exist', () => {
      const state = baseState({ seatOrder: [], currentTurnUserId: null });
      const { state: next, skippedUserId } = forceAdvanceTurn(state, 5000);
      expect(skippedUserId).toBeNull();
      expect(next.currentTurnUserId).toBeNull();
    });
  });

  describe('removeSeat (mid-match forfeit)', () => {
    it('drops the seat from seatOrder', () => {
      const next = removeSeat(baseState(), 'u2', 5000);
      expect(next.seatOrder).toEqual(['u1', 'u3', 'u4']);
    });

    it('hands the turn to the next seat when the removed seat held it', () => {
      const next = removeSeat(baseState(), 'u1', 5000);
      expect(next.currentTurnUserId).toBe('u2');
      expect(next.turnStartedAt).toBe(5000);
    });

    it('leaves the turn untouched when the removed seat did not hold it', () => {
      const next = removeSeat(baseState(), 'u3', 5000);
      expect(next.currentTurnUserId).toBe('u1');
      expect(next.turnStartedAt).toBe(500);
    });

    it('wraps around to find the next seat, skipping the removed one', () => {
      const next = removeSeat(baseState({ currentTurnUserId: 'u4' }), 'u4', 5000);
      expect(next.currentTurnUserId).toBe('u1');
    });

    it('drops the removed seat strike count', () => {
      const state = baseState({ timeoutCounts: { u2: 2 } });
      const next = removeSeat(state, 'u2', 5000);
      expect(next.timeoutCounts).not.toHaveProperty('u2');
    });

    it('never mutates the input state', () => {
      const state = baseState();
      removeSeat(state, 'u1', 5000);
      expect(state.seatOrder).toEqual(SEATS);
      expect(state.currentTurnUserId).toBe('u1');
    });
  });
  /**
   * The state revision — the ordering token a late-joining spectator (and any
   * reconnecting client) uses to decide whether a snapshot it just received is
   * older than the live events it has already applied. Without a monotonic
   * revision there is nothing to compare: `moves.length` is not monotone
   * (`sync_state` compacts the log to a single frame) and `timestamp` is wall
   * clock (not monotone across nodes or a clock step).
   */
  describe('rev (state revision)', () => {
    it('starts a fresh session at rev 0', () => {
      expect(initLiveState(SEATS, 500, 30).rev).toBe(0);
    });

    it('bumps rev on every stored move and stamps the frame with it', () => {
      const s1 = applyMove(baseState(), frame('u1', { action: 'roll_dice', value: 6 }));
      expect(s1.rev).toBe(1);
      expect(s1.moves[0].rev).toBe(1);

      const s2 = applyMove(s1, frame('u1', { action: 'move_token', tokenIndex: 0 }));
      expect(s2.rev).toBe(2);
      expect(s2.moves[1].rev).toBe(2);
    });

    it('does NOT bump rev for an ephemeral aim frame (it changes no stored state)', () => {
      const s1 = applyMove(baseState(), frame('u1', { action: 'roll_dice', value: 6 }));
      const s2 = applyMove(s1, frame('u1', { action: 'aim', angle: 12 }));
      expect(s2.rev).toBe(s1.rev);
      expect(s2.moves).toEqual(s1.moves);
    });

    it('keeps rev monotone across a sync_state log compaction', () => {
      let state = baseState();
      state = applyMove(state, frame('u1', { action: 'roll_dice', value: 6 }));
      state = applyMove(state, frame('u1', { action: 'move_token', tokenIndex: 0 }));
      expect(state.rev).toBe(2);
      expect(state.moves).toHaveLength(2);

      // Compaction throws the log away — rev must NOT go backwards with it.
      const compacted = applyMove(state, frame('u1', { action: 'sync_state', board: {} }));
      expect(compacted.moves).toHaveLength(1);
      expect(compacted.rev).toBe(3);
      expect(compacted.moves[0].rev).toBe(3);
    });

    it('bumps rev when a seat is removed (a forfeit is a state change, not a move)', () => {
      const state = baseState({ rev: 7 });
      expect(removeSeat(state, 'u2', 5000).rev).toBe(8);
    });

    it('bumps rev when the watchdog force-advances a stalled turn', () => {
      const state = baseState({ rev: 7 });
      expect(forceAdvanceTurn(state, 5000).state.rev).toBe(8);
    });

    it('treats a pre-upgrade state with no rev as rev 0 and moves forward from there', () => {
      // A session already live in Redis when this field shipped has no `rev`.
      const legacy = { ...baseState(), rev: undefined } as unknown as GameLiveState;
      expect(applyMove(legacy, frame('u1', { action: 'roll_dice', value: 6 })).rev).toBe(1);
      expect(removeSeat(legacy, 'u2', 5000).rev).toBe(1);
      expect(forceAdvanceTurn(legacy, 5000).state.rev).toBe(1);
    });
  });
});
