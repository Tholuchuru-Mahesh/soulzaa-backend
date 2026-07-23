import {
  applyMove,
  forceAdvanceTurn,
  GameLiveState,
  GameMoveFrame,
  initLiveState,
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
});
